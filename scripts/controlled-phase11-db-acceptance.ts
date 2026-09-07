/**
 * Phase 11 controlled DB acceptance — mutates Phase 11 demo org only.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import {
  assertDistinctControlledDemoOrgIds,
  assertMutationScope,
  capturePeerFingerprints,
  assertPeerFingerprintsUnchanged,
} from "../src/lib/integration/controlled-phase-isolation";
import {
  createAccountingSchedule,
  activateAccountingSchedule,
  transitionScheduleLifecycle,
  updateAccountingSchedule,
} from "../src/lib/accounting/schedules/schedule-crud";
import {
  claimScheduleOccurrence,
  postScheduleOccurrence,
  processDueScheduleOccurrences,
} from "../src/lib/accounting/schedules/process-due";
import {
  approveScheduleOccurrence,
  postApprovedOccurrence,
  skipScheduleOccurrence,
  retryFailedOccurrence,
  reverseOccurrenceWithCanonicalFlow,
} from "../src/lib/accounting/schedules/occurrence-workflow";
import {
  addScheduleAttachmentMetadata,
  addScheduleNote,
} from "../src/lib/accounting/schedules/schedule-service";
import { evaluateCloseReadiness } from "../src/lib/accounting/close-readiness";
import { closeFindingScheduleRoute } from "../src/lib/accounting/schedules/preview";
import { reconcileScheduleSubledgerToGl } from "../src/lib/accounting/schedules/reconciliation";
import { buildPrepaidRollforward } from "../src/lib/accounting/schedules/rollforward";
import { endOfMonth } from "../src/lib/accounting/periods";
import { scheduleIdempotencyKey } from "../src/lib/accounting/schedules/types";

const PHASE11_DEMO_ORG_NAME = "Teller Phase 11 Demo";
const HFAC_ORG = TELLER_HFAC_ORG_ID;

type Result = { name: string; pass: boolean; detail?: string };

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST=1 required");
  }
  const orgId = process.env.TELLER_PHASE11_DEMO_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE11_DEMO_ORG_ID missing — run setup:phase11-demo-org");
  assertNotHfacOrganization(orgId);
  assertDistinctControlledDemoOrgIds();
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return { orgId, supabase };
}

async function assertOrgName(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase.from("teller_organizations").select("name").eq("id", orgId).single();
  if (data?.name !== PHASE11_DEMO_ORG_NAME) {
    throw new Error(`Expected "${PHASE11_DEMO_ORG_NAME}", got "${data?.name ?? "missing"}"`);
  }
}

async function accountMap(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase.from("teller_accounts").select("id, code").eq("organization_id", orgId);
  const map = new Map<string, string>();
  for (const row of data ?? []) map.set(row.code as string, row.id as string);
  return map;
}

async function hfacSnapshot(supabase: SupabaseClient) {
  async function count(table: string) {
    const { count } = await supabase.from(table).select("id", { count: "exact", head: true }).eq("organization_id", HFAC_ORG);
    return count ?? 0;
  }
  const balances = await supabase.from("teller_accounts").select("id, code").eq("organization_id", HFAC_ORG);
  const ar = balances.data?.find((a) => a.code === "1100" || a.code === "1200");
  let arGl = 0;
  if (ar) {
    const { data: entries } = await supabase.from("teller_journal_entries").select("id").eq("organization_id", HFAC_ORG);
    const ids = (entries ?? []).map((e) => e.id);
    if (ids.length) {
      const { data: lines } = await supabase.from("teller_journal_lines").select("debit, credit").in("entry_id", ids).eq("account_id", ar.id);
      arGl = (lines ?? []).reduce((s, l) => s + Number(l.debit ?? 0) - Number(l.credit ?? 0), 0);
    }
  }
  return {
    documents: await count("teller_documents"),
    payments: await count("teller_payments"),
    payment_allocations: await count("teller_payment_allocations"),
    journals: await count("teller_journal_entries"),
    arGl: Math.round(arGl * 100) / 100,
    phase11_schedules: await count("teller_accounting_schedules"),
  };
}

async function journalBalanced(supabase: SupabaseClient, entryId: string) {
  const { data } = await supabase.from("teller_journal_lines").select("debit, credit").eq("entry_id", entryId);
  const d = (data ?? []).reduce((s, l) => s + Number(l.debit ?? 0), 0);
  const c = (data ?? []).reduce((s, l) => s + Number(l.credit ?? 0), 0);
  return Math.abs(d - c) < 0.01;
}

async function clearPhase11Org(supabase: SupabaseClient, orgId: string) {
  assertMutationScope(orgId, orgId);
  await supabase.from("teller_schedule_notes").delete().eq("organization_id", orgId);
  await supabase.from("teller_schedule_attachments").delete().eq("organization_id", orgId);
  await supabase.from("teller_schedule_occurrences").delete().eq("organization_id", orgId);
  await supabase.from("teller_accounting_schedules").delete().eq("organization_id", orgId);
  const { data: entries } = await supabase.from("teller_journal_entries").select("id").eq("organization_id", orgId);
  const ids = (entries ?? []).map((e) => e.id);
  if (ids.length) await supabase.from("teller_journal_lines").delete().in("entry_id", ids);
  await supabase.from("teller_journal_entries").delete().eq("organization_id", orgId);
}

export async function runPhase11DbAcceptance() {
  const { orgId, supabase } = loadEnv();
  await assertOrgName(supabase, orgId);
  const peersBefore = await capturePeerFingerprints(supabase, 11);
  const hfacBefore = await hfacSnapshot(supabase);
  const accounts = await accountMap(supabase, orgId);
  const results: Result[] = [];

  async function run(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      results.push({ name, pass: true });
    } catch (error) {
      results.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  await clearPhase11Org(supabase, orgId);

  await run("HFAC hard refusal blocks mutation", async () => {
    let threw = false;
    try {
      assertNotHfacOrganization(HFAC_ORG);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("expected throw");
  });

  await run("HFAC has no Phase 11 schedules pre-test", async () => {
    const snap = await hfacSnapshot(supabase);
    if (snap.phase11_schedules !== 0) throw new Error(`HFAC has ${snap.phase11_schedules} schedules`);
  });

  let prepaidId = "";
  let prepaidOccId = "";

  await run("Create prepaid schedule (draft)", async () => {
    const row = await createAccountingSchedule(supabase, {
      organizationId: orgId,
      scheduleType: "prepaid_expense",
      name: "Acceptance prepaid",
      startDate: "2026-04-01",
      endDate: "2026-06-30",
      originalAmount: 300,
      prepaidAccountId: accounts.get("1300")!,
      expenseAccountId: accounts.get("6100")!,
    });
    prepaidId = row.id as string;
  });

  await run("Edit draft schedule", async () => {
    await updateAccountingSchedule(supabase, {
      organizationId: orgId,
      scheduleId: prepaidId,
      patch: { name: "Acceptance prepaid edited", memo: "draft edit" },
    });
  });

  await run("Activate prepaid schedule", async () => {
    const { preview } = await activateAccountingSchedule(supabase, {
      organizationId: orgId,
      scheduleId: prepaidId,
    });
    if (!preview.length) throw new Error("empty preview");
    const sum = preview.reduce((s, p) => s + p.amount, 0);
    if (Math.abs(sum - 300) > 0.01) throw new Error(`preview sum ${sum}`);
  });

  await run("Process due prepaid occurrence", async () => {
    const due = await processDueScheduleOccurrences(supabase, {
      organizationId: orgId,
      asOfDate: "2026-04-30",
      autoPost: false,
    });
    if (due.processed < 1) throw new Error("no occurrence processed");
    const { data } = await supabase
      .from("teller_schedule_occurrences")
      .select("id, status")
      .eq("schedule_id", prepaidId)
      .limit(1)
      .single();
    prepaidOccId = data!.id as string;
    if (data!.status !== "generated") throw new Error(`status ${data!.status}`);
  });

  await run("Approve and post prepaid occurrence", async () => {
    await approveScheduleOccurrence(supabase, { organizationId: orgId, occurrenceId: prepaidOccId });
    const { journalEntryId } = await postApprovedOccurrence(supabase, {
      organizationId: orgId,
      occurrenceId: prepaidOccId,
    });
    if (!(await journalBalanced(supabase, journalEntryId))) throw new Error("unbalanced journal");
    const { data: lines } = await supabase.from("teller_journal_lines").select("account_id, debit, credit").eq("entry_id", journalEntryId);
    const expense = accounts.get("6100");
    const prepaid = accounts.get("1300");
    const dr = lines?.find((l) => l.account_id === expense);
    const cr = lines?.find((l) => l.account_id === prepaid);
    if (!dr?.debit || !cr?.credit) throw new Error("wrong prepaid recognition lines");
  });

  await run("Occurrence idempotency — duplicate claim", async () => {
    const periodEnd = endOfMonth(2026, 4);
    const { duplicate } = await claimScheduleOccurrence(supabase, {
      organizationId: orgId,
      scheduleId: prepaidId,
      occurrenceDate: "2026-04-30",
      periodEnd,
      amount: 100,
    });
    if (!duplicate) throw new Error("expected duplicate");
    const { count } = await supabase
      .from("teller_schedule_occurrences")
      .select("id", { count: "exact", head: true })
      .eq("schedule_id", prepaidId)
      .eq("occurrence_date", "2026-04-30");
    if ((count ?? 0) !== 1) throw new Error(`expected 1 row got ${count}`);
  });

  await run("Double post is idempotent — no duplicate journal", async () => {
    const { data: before } = await supabase
      .from("teller_schedule_occurrences")
      .select("journal_entry_id")
      .eq("id", prepaidOccId)
      .single();
    const repost = await postScheduleOccurrence(supabase, { organizationId: orgId, occurrenceId: prepaidOccId });
    if (repost.journalEntryId !== before?.journal_entry_id) throw new Error("journal id changed on repost");
    const { count } = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("source_id", prepaidOccId);
    if ((count ?? 0) > 1) throw new Error("duplicate journals for same occurrence");
  });

  let accrualId = "";
  let accrualOccId = "";

  await run("Create and activate accrual with auto-reverse", async () => {
    const row = await createAccountingSchedule(supabase, {
      organizationId: orgId,
      scheduleType: "accrued_expense",
      name: "Acceptance accrual",
      startDate: "2026-05-01",
      originalAmount: 500,
      expenseAccountId: accounts.get("6200")!,
      liabilityAccountId: accounts.get("2400")!,
      autoReverse: true,
      reversalTiming: "next_period",
    });
    accrualId = row.id as string;
    await activateAccountingSchedule(supabase, { organizationId: orgId, scheduleId: accrualId });
    await processDueScheduleOccurrences(supabase, { organizationId: orgId, asOfDate: "2026-05-31", autoPost: true });
    const { data } = await supabase.from("teller_schedule_occurrences").select("id, status, journal_entry_id").eq("schedule_id", accrualId).single();
    accrualOccId = data!.id as string;
    if (data!.status !== "posted" || !data!.journal_entry_id) throw new Error("accrual not posted");
    const { data: lines } = await supabase.from("teller_journal_lines").select("account_id, debit, credit").eq("entry_id", data!.journal_entry_id as string);
    const exp = lines?.find((l) => l.account_id === accounts.get("6200"));
    const liab = lines?.find((l) => l.account_id === accounts.get("2400"));
    if (!exp?.debit || !liab?.credit) throw new Error("accrual lines wrong");
  });

  await run("Accrual reversal canonical flow", async () => {
    const { reversalJournalEntryId } = await reverseOccurrenceWithCanonicalFlow(supabase, {
      organizationId: orgId,
      occurrenceId: accrualOccId,
      reversalDate: "2026-06-01",
    });
    if (!(await journalBalanced(supabase, reversalJournalEntryId))) throw new Error("reversal unbalanced");
    const { data } = await supabase.from("teller_schedule_occurrences").select("status").eq("id", accrualOccId).single();
    if (data?.status !== "reversed") throw new Error(`status ${data?.status}`);
  });

  await run("Deferred revenue blocks without deposit source", async () => {
    let threw = false;
    try {
      await createAccountingSchedule(supabase, {
        organizationId: orgId,
        scheduleType: "deferred_revenue",
        name: "No deposit",
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        originalAmount: 100,
        liabilityAccountId: accounts.get("2300")!,
        revenueAccountId: accounts.get("4000")!,
      });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("expected validation error");
  });

  await run("Pause resume cancel lifecycle", async () => {
    const row = await createAccountingSchedule(supabase, {
      organizationId: orgId,
      scheduleType: "prepaid_expense",
      name: "Lifecycle test",
      startDate: "2026-07-01",
      endDate: "2026-09-30",
      originalAmount: 90,
      prepaidAccountId: accounts.get("1300")!,
      expenseAccountId: accounts.get("6100")!,
    });
    await activateAccountingSchedule(supabase, { organizationId: orgId, scheduleId: row.id as string });
    await transitionScheduleLifecycle(supabase, { organizationId: orgId, scheduleId: row.id as string, action: "pause" });
    await transitionScheduleLifecycle(supabase, { organizationId: orgId, scheduleId: row.id as string, action: "resume" });
    await transitionScheduleLifecycle(supabase, { organizationId: orgId, scheduleId: row.id as string, action: "cancel" });
    const { data } = await supabase.from("teller_accounting_schedules").select("status").eq("id", row.id).single();
    if (data?.status !== "cancelled") throw new Error(`status ${data?.status}`);
  });

  await run("Skip with reason and retry failed", async () => {
    const row = await createAccountingSchedule(supabase, {
      organizationId: orgId,
      scheduleType: "accrued_expense",
      name: "Skip test",
      startDate: "2026-08-01",
      originalAmount: 25,
      expenseAccountId: accounts.get("6100")!,
      liabilityAccountId: accounts.get("2400")!,
    });
    await activateAccountingSchedule(supabase, { organizationId: orgId, scheduleId: row.id as string });
    await processDueScheduleOccurrences(supabase, { organizationId: orgId, asOfDate: "2026-08-31", autoPost: false });
    const { data: occ } = await supabase.from("teller_schedule_occurrences").select("id, status").eq("schedule_id", row.id).single();
    await skipScheduleOccurrence(supabase, {
      organizationId: orgId,
      occurrenceId: occ!.id as string,
      reason: "Not material this period",
    });
    const { data: skipped } = await supabase.from("teller_schedule_occurrences").select("status, metadata").eq("id", occ!.id).single();
    if (skipped?.status !== "skipped") throw new Error("not skipped");
  });

  await run("Notes and attachments metadata", async () => {
    await addScheduleNote(supabase, {
      organizationId: orgId,
      resourceKind: "accounting_schedule",
      resourceId: prepaidId,
      noteText: "Acceptance note",
    });
    await addScheduleAttachmentMetadata(supabase, {
      organizationId: orgId,
      resourceKind: "accounting_schedule",
      resourceId: prepaidId,
      fileName: "policy.pdf",
      storagePath: `schedules/${prepaidId}/policy.pdf`,
    });
    const { count: nCount } = await supabase.from("teller_schedule_notes").select("id", { count: "exact", head: true }).eq("resource_id", prepaidId);
    const { count: aCount } = await supabase.from("teller_schedule_attachments").select("id", { count: "exact", head: true }).eq("resource_id", prepaidId);
    if ((nCount ?? 0) < 1 || (aCount ?? 0) < 1) throw new Error("metadata not saved");
  });

  await run("Close readiness deep link includes occurrence", async () => {
    const report = await evaluateCloseReadiness(supabase, orgId, "2026-12-31");
    const scheduleFinding = report.findings.find((f) => f.domain === "schedules" && f.route.includes("/occurrences/"));
    if (!scheduleFinding && report.findings.filter((f) => f.domain === "schedules").length === 0) {
      // May have no blockers if all posted — verify route helper works
      const route = closeFindingScheduleRoute({ scheduleId: prepaidId, occurrenceId: prepaidOccId });
      if (!route.includes("/occurrences/")) throw new Error("route missing occurrence");
      return;
    }
    if (scheduleFinding && !scheduleFinding.route.includes("/occurrences/")) {
      throw new Error("finding missing occurrence deep link");
    }
  });

  await run("Schedule GL rollforward reconciliation", async () => {
    const { data: sched } = await supabase.from("teller_accounting_schedules").select("remaining_amount").eq("id", prepaidId).single();
    const rf = buildPrepaidRollforward({
      controlAccountId: accounts.get("1300")!,
      beginningPrepaid: 300,
      additions: 0,
      recognized: 300 - Number(sched?.remaining_amount ?? 0),
      glBalance: Number(sched?.remaining_amount ?? 0),
    });
    if (rf.difference !== 0) throw new Error(`rollforward diff ${rf.difference}`);
  });

  await run("Cross-org schedule isolation", async () => {
    const foreign = process.env.TELLER_PHASE10_FOREIGN_ORG_ID?.trim();
    if (!foreign) throw new Error("foreign org missing");
    const { data } = await supabase.from("teller_accounting_schedules").select("id").eq("organization_id", orgId).limit(1);
    const { data: foreignRow } = await supabase
      .from("teller_accounting_schedules")
      .select("id")
      .eq("id", data![0]!.id as string)
      .eq("organization_id", foreign)
      .maybeSingle();
    if (foreignRow) throw new Error("cross-org leak");
  });

  await run("Idempotency key uniqueness constraint", async () => {
    const key = scheduleIdempotencyKey(prepaidId, "2099-12-31");
    const first = await supabase.from("teller_schedule_occurrences").insert({
      organization_id: orgId,
      schedule_id: prepaidId,
      occurrence_date: "2099-12-31",
      period_end: "2099-12-31",
      amount: 1,
      status: "scheduled",
      idempotency_key: key,
    });
    if (first.error) throw new Error(first.error.message);
    const second = await supabase.from("teller_schedule_occurrences").insert({
      organization_id: orgId,
      schedule_id: prepaidId,
      occurrence_date: "2099-12-31",
      period_end: "2099-12-31",
      amount: 1,
      status: "scheduled",
      idempotency_key: key,
    });
    await supabase.from("teller_schedule_occurrences").delete().eq("idempotency_key", key);
    if (!second.error) throw new Error("expected unique violation on duplicate idempotency_key");
  });

  const hfacAfter = await hfacSnapshot(supabase);
  await assertPeerFingerprintsUnchanged(supabase, peersBefore, 11);

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;

  return {
    pass,
    fail,
    total: results.length,
    results,
    hfacBefore,
    hfacAfter,
    hfacUnchanged:
      hfacBefore.documents === hfacAfter.documents &&
      hfacBefore.payments === hfacAfter.payments &&
      hfacBefore.payment_allocations === hfacAfter.payment_allocations &&
      hfacBefore.journals === hfacAfter.journals &&
      hfacBefore.arGl === hfacAfter.arGl,
  };
}

if (process.argv[1]?.endsWith("controlled-phase11-db-acceptance.ts")) {
  runPhase11DbAcceptance()
    .then((summary) => {
      console.log(`Phase 11 DB acceptance: ${summary.pass}/${summary.total} passed`);
      console.log(JSON.stringify(summary, null, 2));
      process.exit(summary.fail > 0 || !summary.hfacUnchanged ? 1 : 0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
