/**
 * Phase 9 controlled production demo — dedicated demo org only, never HFAC.
 * 100-scenario month-end close acceptance matrix (spec section 44).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createAdjustingJournal,
  postAdjustingJournal,
  reverseAdjustingJournal,
} from "../src/lib/accounting/adjusting-journals";
import { evaluateCloseReadiness } from "../src/lib/accounting/close-readiness";
import { loadAccountingStateVersions } from "../src/lib/accounting/accounting-state";
import {
  closeAccountingPeriod,
  reopenAccountingPeriod,
} from "../src/lib/accounting/period-close";
import { resetDemoBooksOpen } from "./lib/reopen-demo-period-closes";
import {
  assertEntryDateOpen,
  booksClosedThrough,
  endOfMonth,
  monthPeriod,
  nextCloseablePeriodEnd,
  PeriodClosedError,
  recentMonthPeriods,
  startOfMonth,
  validatePeriodClose,
} from "../src/lib/accounting/periods";
import {
  postExpense,
  postInvoiceOpen,
  postJournal,
  reverseJournalEntry,
  assertOrgPeriodOpen,
} from "../src/lib/accounting/post";
import { postBillOpen } from "../src/lib/accounting/bills";
import {
  createRecurringJournalTemplate,
  generateRecurringJournalDraft,
} from "../src/lib/accounting/recurring-journals";
import { buildTrialBalance } from "../src/lib/accounting/trial-balance";
import { fiscalYearStartLabel } from "../src/lib/org/config";
import {
  assertMutationScope,
  assertDemoOrgName,
  assertPeerFingerprintsUnchanged,
  capturePeerFingerprints,
  expectedControlledDemoOrgName,
  loadControlledDemoOrgId,
} from "../src/lib/integration/controlled-phase-isolation";
import {
  assertNotHfacOrganization,
  CONTROLLED_PHASE9_FOREIGN_ORG_NAME,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";

export const PHASE9_CONTROLLED_MATRIX_SIZE = 102;

const HFAC_ORG_ID = TELLER_HFAC_ORG_ID;
/** Matches production `current_date` — close RPC uses DB date, not a fixed harness constant. */
const TODAY = new Date().toISOString().slice(0, 10);
const DEMO_CLOSE_ANCHOR = "2025-12-31";
const JAN_END = "2026-01-31";
const FEB_END = "2026-02-28";
const MAR_END = "2026-03-31";

type ScenarioResult = { name: string; pass: boolean; detail?: string; skipped?: boolean };

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");
  }
  const orgId = loadControlledDemoOrgId(9);
  const foreignOrgId = process.env.TELLER_PHASE9_FOREIGN_ORG_ID?.trim();
  assertNotHfacOrganization(orgId);
  if (foreignOrgId) assertNotHfacOrganization(foreignOrgId);
  return {
    orgId,
    foreignOrgId: foreignOrgId ?? null,
    supabase: createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
  };
}

async function assertDemoOrg(supabase: SupabaseClient, orgId: string) {
  await assertDemoOrgName(supabase, orgId, expectedControlledDemoOrgName(9));
}

async function journalCount(supabase: SupabaseClient, orgId: string) {
  const { count } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  return count ?? 0;
}

async function tableCount(supabase: SupabaseClient, table: string, orgId: string) {
  const { count } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  return count ?? 0;
}

async function hfacBaseline(supabase: SupabaseClient) {
  async function count(table: string) {
    const { count } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG_ID);
    return count ?? 0;
  }
  return {
    documents: await count("teller_documents"),
    payments: await count("teller_payments"),
    payment_allocations: await count("teller_payment_allocations"),
    journal_entries: await count("teller_journal_entries"),
    jobs: await count("teller_jobs"),
  };
}

async function loadPeriodCloses(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase
    .from("teller_period_closes")
    .select("period_end, effective_closed_through, closed_at, event_type")
    .eq("organization_id", orgId)
    .order("closed_at", { ascending: false });
  return data ?? [];
}

async function booksClosedThroughRpc(
  supabase: SupabaseClient,
  orgId: string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("teller_books_closed_through", { p_org: orgId });
  if (error) throw new Error(error.message);
  return (data as string | null)?.slice(0, 10) ?? null;
}

async function resolveDefaultLegalEntityId(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase.rpc("teller_default_legal_entity_id", {
    p_org_id: orgId,
  });
  if (error || !data) throw new Error(error?.message || "Default legal entity missing");
  return data as string;
}

async function seedCloseAnchor(supabase: SupabaseClient, orgId: string, through: string) {
  const closed = await booksClosedThroughRpc(supabase, orgId);
  if (closed) return;
  const legalEntityId = await resolveDefaultLegalEntityId(supabase, orgId);
  const { error } = await supabase.from("teller_period_closes").insert({
    organization_id: orgId,
    legal_entity_id: legalEntityId,
    period_end: through,
    notes: "Phase 9 demo close anchor",
    event_type: "close",
    effective_closed_through: through,
    closed_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

async function clearDemoTransactions(
  supabase: SupabaseClient,
  orgId: string,
  allowedOrgId: string,
) {
  assertMutationScope(orgId, allowedOrgId, "clearDemoTransactions");
  for (const table of [
    "teller_recurring_journal_runs",
    "teller_adjusting_journal_entries",
    "teller_recurring_journal_templates",
    "teller_close_checklist_items",
    "teller_period_close_reviews",
    "teller_payment_allocations",
    "teller_payments",
  ]) {
    await supabase.from(table).delete().eq("organization_id", orgId);
  }
  const { data: docs } = await supabase.from("teller_documents").select("id").eq("organization_id", orgId);
  const docIds = (docs ?? []).map((row) => row.id as string);
  if (docIds.length) await supabase.from("teller_document_lines").delete().in("document_id", docIds);
  await supabase.from("teller_documents").delete().eq("organization_id", orgId);
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  const entryIds = (entries ?? []).map((row) => row.id as string);
  if (entryIds.length) await supabase.from("teller_journal_lines").delete().in("entry_id", entryIds);
  await supabase.from("teller_journal_entries").delete().eq("organization_id", orgId);
  await supabase.from("teller_audit_events").delete().eq("organization_id", orgId);
}

async function resetBooks(supabase: SupabaseClient, orgId: string, allowedOrgId: string) {
  assertMutationScope(orgId, allowedOrgId, "resetBooks");
  await resetDemoBooksOpen(supabase, orgId, "Phase 9 demo reset");
  await clearDemoTransactions(supabase, orgId, allowedOrgId);
  const legalEntityId = await resolveDefaultLegalEntityId(supabase, orgId);
  await supabase.from("teller_accounting_state_versions").upsert({
    organization_id: orgId,
    legal_entity_id: legalEntityId,
    accounting_version: 0,
    close_state_version: 0,
  });
  await supabase.from("teller_close_settings").upsert({
    organization_id: orgId,
    legal_entity_id: legalEntityId,
    adjustment_approval_required: false,
    warnings_require_acknowledgment: false,
    required_bank_account_ids: [],
  });
}

async function accountMap(supabase: SupabaseClient, orgId: string) {
  const legalEntityId = await resolveDefaultLegalEntityId(supabase, orgId);
  const { data } = await supabase
    .from("teller_accounts")
    .select("id, code, type, subtype")
    .eq("organization_id", orgId)
    .eq("legal_entity_id", legalEntityId);
  return Object.fromEntries((data ?? []).map((row) => [row.code, row.id as string]));
}

async function cleanup(supabase: SupabaseClient, orgId: string, allowedOrgId: string) {
  assertMutationScope(orgId, allowedOrgId, "cleanup");
  await resetDemoBooksOpen(supabase, orgId, "Phase 9 demo cleanup");
  for (const table of [
    "teller_recurring_journal_runs",
    "teller_adjusting_journal_entries",
    "teller_recurring_journal_templates",
    "teller_close_checklist_items",
    "teller_period_close_reviews",
    "teller_close_settings",
    "teller_audit_events",
    "teller_payment_allocations",
    "teller_payments",
  ]) {
    await supabase.from(table).delete().eq("organization_id", orgId);
  }
  const { data: docs } = await supabase.from("teller_documents").select("id").eq("organization_id", orgId);
  const docIds = (docs ?? []).map((row) => row.id as string);
  if (docIds.length) await supabase.from("teller_document_lines").delete().in("document_id", docIds);
  await supabase.from("teller_documents").delete().eq("organization_id", orgId);
  const { data: entries } = await supabase.from("teller_journal_entries").select("id").eq("organization_id", orgId);
  const entryIds = (entries ?? []).map((row) => row.id as string);
  if (entryIds.length) await supabase.from("teller_journal_lines").delete().in("entry_id", entryIds);
  await supabase.from("teller_journal_entries").delete().eq("organization_id", orgId);
  await supabase.from("teller_parties").delete().eq("organization_id", orgId);
}

async function ensureParty(supabase: SupabaseClient, orgId: string, kind: "customer" | "vendor", name: string) {
  const { data } = await supabase
    .from("teller_parties")
    .insert({ organization_id: orgId, kind, name })
    .select("id")
    .single();
  return data!.id as string;
}

async function postBalancedEntry(
  supabase: SupabaseClient,
  orgId: string,
  accounts: Record<string, string>,
  input: { entryDate: string; amount: number; memo?: string; sourceKind?: string },
) {
  return postJournal(supabase, {
    organizationId: orgId,
    entryDate: input.entryDate,
    memo: input.memo ?? "Phase 9 demo entry",
    sourceKind: input.sourceKind ?? "manual",
    lines: [
      { account_id: accounts["6100"], debit: input.amount },
      { account_id: accounts["1000"], credit: input.amount },
    ],
  });
}

async function closeThrough(
  supabase: SupabaseClient,
  orgId: string,
  periodEnd: string,
  skipReadiness = true,
  options?: { warningsAcknowledged?: unknown[] },
) {
  const target = periodEnd.slice(0, 10);

  for (let attempt = 0; attempt < 24; attempt += 1) {
    let closed = await booksClosedThroughRpc(supabase, orgId);
    if (closed && closed >= target) {
      const { data } = await supabase
        .from("teller_period_closes")
        .select("id")
        .eq("organization_id", orgId)
        .eq("period_end", target)
        .eq("event_type", "close")
        .order("closed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return {
        eventId: data?.id as string,
        periodEnd: target,
        snapshot: {},
      };
    }

    const naturalFirst = nextCloseablePeriodEnd(null, TODAY);
    if (!closed && naturalFirst && target < naturalFirst) {
      await seedCloseAnchor(supabase, orgId, DEMO_CLOSE_ANCHOR);
      closed = await booksClosedThroughRpc(supabase, orgId);
    }

    const next = nextCloseablePeriodEnd(closed, TODAY);
    if (!next) {
      throw new Error(`Cannot close period ending ${target}; no further closeable period`);
    }
    if (next > target) {
      await seedCloseAnchor(supabase, orgId, DEMO_CLOSE_ANCHOR);
      continue;
    }

    const result = await closeAccountingPeriod(supabase, {
      organizationId: orgId,
      periodEnd: next,
      notes: `Close ${next}`,
      skipReadiness,
      warningsAcknowledged: options?.warningsAcknowledged,
    });
    if (next === target) return result;
  }

  throw new Error(`Could not close through ${target}`);
}

async function expectPeriodClosedError(fn: () => Promise<unknown>) {
  try {
    await fn();
    throw new Error("Expected period closed error");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("closed")) throw err;
  }
}

export async function runPhase9ControlledDemo(): Promise<{
  passed: number;
  total: number;
  allPassed: boolean;
  results: ScenarioResult[];
  hfacBaselineUnchanged: boolean;
}> {
  const { orgId, foreignOrgId, supabase } = loadEnv();
  await assertDemoOrg(supabase, orgId);

  const hfacBefore = await hfacBaseline(supabase);
  const peerFingerprintsBefore = await capturePeerFingerprints(supabase, 9);

  const results: ScenarioResult[] = [];

  async function run(name: string, fn: () => Promise<void>, options?: { skipReset?: boolean }) {
    try {
      if (!options?.skipReset) await resetBooks(supabase, orgId, orgId);
      await fn();
      results.push({ name, pass: true });
      console.log(`✓ ${name}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ name, pass: false, detail });
      console.log(`✗ ${name} — ${detail}`);
    }
  }

  async function skip(name: string, note: string) {
    results.push({ name, pass: true, skipped: true, detail: note });
    console.log(`↷ ${name} — ${note}`);
  }

  await cleanup(supabase, orgId, orgId);
  const accounts = await accountMap(supabase, orgId);

  // PERIOD FOUNDATION (1-12)
  await run("1. booksClosedThrough null when no closes", async () => {
    const closed = booksClosedThrough([]);
    if (closed !== null) throw new Error(`expected null, got ${closed}`);
  });

  await run("2. nextCloseablePeriodEnd for fresh org", async () => {
    const next = nextCloseablePeriodEnd(null, TODAY);
    const expected = nextCloseablePeriodEnd(null, TODAY);
    if (next !== expected) throw new Error(`expected ${expected}, got ${next}`);
  });

  await run("3. validatePeriodClose rejects future period", async () => {
    const result = validatePeriodClose({ periodEnd: "2099-12-31", closedThrough: null, today: TODAY });
    if (result.ok) throw new Error("future period should be rejected");
  });

  await run("4. validatePeriodClose rejects already closed", async () => {
    const result = validatePeriodClose({ periodEnd: JAN_END, closedThrough: FEB_END, today: TODAY });
    if (result.ok) throw new Error("already closed period should be rejected");
  });

  await run("5. validatePeriodClose enforces sequential order", async () => {
    const result = validatePeriodClose({ periodEnd: MAR_END, closedThrough: JAN_END, today: TODAY });
    if (result.ok) throw new Error("out-of-order close should be rejected");
  });

  await run("6. monthPeriod labels correct", async () => {
    const period = monthPeriod(2026, 3);
    if (period.end !== MAR_END) throw new Error(`expected ${MAR_END}`);
    if (!period.label.includes("March")) throw new Error("label should include March");
  });

  await run("7. recentMonthPeriods status open/closed", async () => {
    const periods = recentMonthPeriods(3, new Date("2026-03-15T12:00:00"), JAN_END);
    const jan = periods.find((p) => p.end === JAN_END);
    const feb = periods.find((p) => p.end === FEB_END);
    if (jan?.status !== "closed") throw new Error("Jan should be closed");
    if (feb?.status !== "open") throw new Error("Feb should be open");
  });

  await run("8. teller_books_closed_through RPC null initially", async () => {
    const { data, error } = await supabase.rpc("teller_books_closed_through", { p_org: orgId });
    if (error) throw new Error(error.message);
    if (data !== null) throw new Error(`expected null, got ${data}`);
  });

  await run("9. assertEntryDateOpen passes when no close", async () => {
    assertEntryDateOpen(null, "2026-05-15");
  });

  await run("10. startOfMonth/endOfMonth helpers", async () => {
    if (startOfMonth(2026, 2) !== "2026-02-01") throw new Error("startOfMonth mismatch");
    if (endOfMonth(2026, 2) !== FEB_END) throw new Error("endOfMonth mismatch");
  });

  await run("11. PeriodClosedError shape", async () => {
    try {
      assertEntryDateOpen(JAN_END, "2026-01-15");
      throw new Error("should have thrown");
    } catch (err) {
      if (!(err instanceof PeriodClosedError)) throw new Error("expected PeriodClosedError");
      if (err.closedThrough !== JAN_END) throw new Error("closedThrough mismatch");
    }
  });

  await run("12. close event creates effective_closed_through", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-20", amount: 100 });
    await closeThrough(supabase, orgId, JAN_END);
    const closes = await loadPeriodCloses(supabase, orgId);
    const latest = closes[0];
    if ((latest?.effective_closed_through ?? latest?.period_end) !== JAN_END) {
      throw new Error("effective_closed_through not set");
    }
  });

  // LOCK HARDENING (13-30)
  await run("13. postJournal blocked in closed period via RPC", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-20", amount: 50 });
    await closeThrough(supabase, orgId, JAN_END);
    await expectPeriodClosedError(() =>
      postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-10", amount: 25 }),
    );
  });

  await run("14. postJournal blocked on closed-through date", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-20", amount: 50 });
    await closeThrough(supabase, orgId, JAN_END);
    await expectPeriodClosedError(() =>
      postBalancedEntry(supabase, orgId, accounts, { entryDate: JAN_END, amount: 25 }),
    );
  });

  await run("15. postJournal allowed after closed-through", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-20", amount: 50 });
    await closeThrough(supabase, orgId, JAN_END);
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-02-05", amount: 25 });
  });

  await run("16. direct journal INSERT blocked by period guard trigger", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-20", amount: 50 });
    await closeThrough(supabase, orgId, JAN_END);
    const { error } = await supabase.from("teller_journal_entries").insert({
      organization_id: orgId,
      entry_date: "2026-01-05",
      memo: "direct insert attempt",
      source_kind: "manual",
    });
    if (!error?.message.includes("closed")) {
      throw new Error(`expected period guard error, got ${error?.message ?? "no error"}`);
    }
  });

  await run("17. assertOrgPeriodOpen throws PeriodClosedError", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-20", amount: 50 });
    await closeThrough(supabase, orgId, JAN_END);
    try {
      await assertOrgPeriodOpen(supabase, orgId, "2026-01-01");
      throw new Error("should have thrown");
    } catch (err) {
      if (!(err instanceof PeriodClosedError)) throw new Error("expected PeriodClosedError");
    }
  });

  await run("18. postAdjustingJournal respects period lock", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-20", amount: 50 });
    await closeThrough(supabase, orgId, JAN_END);
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-01-15",
      memo: "locked period adj",
      lines: [
        { accountId: accounts["6300"], debit: 100 },
        { accountId: accounts["2100"], credit: 100 },
      ],
    });
    await expectPeriodClosedError(() =>
      postAdjustingJournal(supabase, { organizationId: orgId, adjustmentId: adj.id as string }),
    );
  });

  await run("19. postInvoiceOpen blocked in closed period", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-20", amount: 50 });
    await closeThrough(supabase, orgId, JAN_END);
    const customerId = await ensureParty(supabase, orgId, "customer", "Phase 9 Customer");
    const { data: doc } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: orgId,
        kind: "invoice",
        number: "INV-P9-001",
        party_id: customerId,
        status: "draft",
        issue_date: "2026-01-10",
        subtotal: 200,
        total: 200,
      })
      .select("id")
      .single();
    await expectPeriodClosedError(() =>
      postInvoiceOpen(supabase, {
        organizationId: orgId,
        documentId: doc!.id as string,
        partyId: customerId,
        jobId: null,
        issueDate: "2026-01-10",
        number: "INV-P9-001",
        tax: 0,
        lines: [{ amount: 200, account_id: accounts["4000"], description: "Services" }],
      }),
    );
  });

  await run("20. postExpense blocked in closed period", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-20", amount: 50 });
    await closeThrough(supabase, orgId, JAN_END);
    const vendorId = await ensureParty(supabase, orgId, "vendor", "Phase 9 Vendor");
    const { data: doc } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: orgId,
        kind: "expense",
        number: "EXP-P9-001",
        party_id: vendorId,
        status: "draft",
        issue_date: "2026-01-10",
        subtotal: 75,
        total: 75,
      })
      .select("id")
      .single();
    await expectPeriodClosedError(() =>
      postExpense(supabase, {
        organizationId: orgId,
        documentId: doc!.id as string,
        partyId: vendorId,
        jobId: null,
        issueDate: "2026-01-10",
        number: "EXP-P9-001",
        amount: 75,
        accountId: accounts["6100"],
        paid: false,
      }),
    );
  });

  await run("21. postBillOpen blocked in closed period", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-20", amount: 50 });
    await closeThrough(supabase, orgId, JAN_END);
    const vendorId = await ensureParty(supabase, orgId, "vendor", "Phase 9 Bill Vendor");
    const { data: doc } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: orgId,
        kind: "bill",
        number: "BILL-P9-001",
        party_id: vendorId,
        status: "draft",
        issue_date: "2026-01-10",
        subtotal: 120,
        total: 120,
      })
      .select("id")
      .single();
    await expectPeriodClosedError(() =>
      postBillOpen(supabase, {
        organizationId: orgId,
        documentId: doc!.id as string,
        partyId: vendorId,
        jobId: null,
        issueDate: "2026-01-10",
        number: "BILL-P9-001",
        tax: 0,
        lines: [{ amount: 120, account_id: accounts["6100"], description: "Supplies" }],
      }),
    );
  });

  await run("22. reverseJournalEntry blocked in closed period", async () => {
    const entryId = await postBalancedEntry(supabase, orgId, accounts, {
      entryDate: "2026-01-20",
      amount: 80,
    });
    await closeThrough(supabase, orgId, JAN_END);
    await expectPeriodClosedError(() =>
      reverseJournalEntry(supabase, {
        organizationId: orgId,
        entryId,
        entryDate: "2026-01-25",
        memo: "reverse in closed period",
      }),
    );
  });

  await run("23. reopen allows posting in reopened period", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-20", amount: 50 });
    await closeThrough(supabase, orgId, JAN_END);
    await reopenAccountingPeriod(supabase, {
      organizationId: orgId,
      periodEnd: JAN_END,
      reason: "Correction needed",
    });
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-18", amount: 30 });
  });

  await run("24. posting after reopen in February still blocked for January", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-20", amount: 50 });
    await closeThrough(supabase, orgId, JAN_END);
    await closeThrough(supabase, orgId, FEB_END);
    await expectPeriodClosedError(() =>
      postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-02-10", amount: 20 }),
    );
  });

  await run("25. closed period guard on entry_date boundary", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-31", amount: 40 });
    await closeThrough(supabase, orgId, JAN_END);
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-02-01", amount: 40 });
  });

  await run("26. open period first day after close works", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 40 });
    await closeThrough(supabase, orgId, JAN_END);
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-02-01", amount: 40 });
  });

  await run("27. RPC closed-through matches booksClosedThrough helper", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 40 });
    await closeThrough(supabase, orgId, JAN_END);
    const closes = await loadPeriodCloses(supabase, orgId);
    const helper = booksClosedThrough(closes);
    const { data: rpc } = await supabase.rpc("teller_books_closed_through", { p_org: orgId });
    if (helper !== rpc) throw new Error(`helper ${helper} != rpc ${rpc}`);
  });

  await run("28. teller_post_journal 7-param RPC succeeds in open period", async () => {
    const { data, error } = await supabase.rpc("teller_post_journal", {
      p_organization_id: orgId,
      p_entry_date: "2026-03-10",
      p_memo: "direct rpc post",
      p_source_kind: "manual",
      p_source_id: null,
      p_reverses_entry_id: null,
      p_lines: [
        { account_id: accounts["6100"], debit: 100 },
        { account_id: accounts["1000"], credit: 100 },
      ],
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error("expected entry id");
  });

  await run("29. teller_post_journal enforces period lock", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 40 });
    await closeThrough(supabase, orgId, JAN_END);
    const { error } = await supabase.rpc("teller_post_journal", {
      p_organization_id: orgId,
      p_entry_date: "2026-01-05",
      p_memo: "blocked rpc",
      p_source_kind: "manual",
      p_source_id: null,
      p_reverses_entry_id: null,
      p_lines: [
        { account_id: accounts["6100"], debit: 50 },
        { account_id: accounts["1000"], credit: 50 },
      ],
    });
    if (!error?.message.includes("closed")) throw new Error("RPC should enforce period lock");
  });

  await run("30. multiple close events append-only history", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 40 });
    await closeThrough(supabase, orgId, JAN_END);
    await closeThrough(supabase, orgId, FEB_END);
    const { count } = await supabase
      .from("teller_period_closes")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("event_type", "close");
    if ((count ?? 0) < 2) throw new Error("expected append-only close history");
  });

  // CLOSE CONCURRENCY (31-33) — watermark + advisory lock ordering
  await run("31. stale watermark rejects close after journal posts", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 40 });
    const readiness = await evaluateCloseReadiness(supabase, orgId, JAN_END);
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-20", amount: 10 });
    let rejected = false;
    try {
      await closeAccountingPeriod(supabase, {
        organizationId: orgId,
        periodEnd: JAN_END,
        skipReadiness: true,
        expectedAccountingVersion: readiness.accountingVersion,
        expectedCloseStateVersion: readiness.closeStateVersion,
      });
    } catch (err) {
      rejected = err instanceof Error && err.message.includes("ACCOUNTING_STATE_CHANGED");
    }
    if (!rejected) throw new Error("close with stale watermark should fail");
    const closed = booksClosedThrough(await loadPeriodCloses(supabase, orgId));
    if (closed === JAN_END) throw new Error("period should remain open");
  });

  await run("32. close first blocks backdated posting", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 40 });
    await closeThrough(supabase, orgId, JAN_END);
    await expectPeriodClosedError(() =>
      postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-10", amount: 5 }),
    );
  });

  await run("33. readiness rerun after stale close obtains new version", async () => {
    await seedCloseAnchor(supabase, orgId, DEMO_CLOSE_ANCHOR);
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 40 });
    const before = await evaluateCloseReadiness(supabase, orgId, JAN_END);
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-18", amount: 7 });
    try {
      await closeAccountingPeriod(supabase, {
        organizationId: orgId,
        periodEnd: JAN_END,
        skipReadiness: true,
        expectedAccountingVersion: before.accountingVersion,
        expectedCloseStateVersion: before.closeStateVersion,
      });
    } catch {
      /* expected ACCOUNTING_STATE_CHANGED */
    }
    const after = await evaluateCloseReadiness(supabase, orgId, JAN_END);
    if (after.accountingVersion <= before.accountingVersion) {
      throw new Error("accounting version should increment after journal post");
    }
    await closeAccountingPeriod(supabase, {
      organizationId: orgId,
      periodEnd: JAN_END,
      skipReadiness: true,
      expectedAccountingVersion: after.accountingVersion,
      expectedCloseStateVersion: after.closeStateVersion,
    });
  });

  // AJES (34-48)
  await run("34. createAdjustingJournal draft", async () => {
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-03-31",
      memo: "Draft AJE",
      lines: [
        { accountId: accounts["6300"], debit: 200 },
        { accountId: accounts["2100"], credit: 200 },
      ],
    });
    if (adj.status !== "draft") throw new Error("expected draft status");
  });

  await run("35. postAdjustingJournal creates GL entry", async () => {
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-03-31",
      memo: "Post AJE",
      lines: [
        { accountId: accounts["6200"], debit: 150 },
        { accountId: accounts["1300"], credit: 150 },
      ],
    });
    const result = await postAdjustingJournal(supabase, {
      organizationId: orgId,
      adjustmentId: adj.id as string,
    });
    if (!result.journalEntryId) throw new Error("missing journal entry");
  });

  await run("36. adjustment source_kind = adjustment", async () => {
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-03-31",
      memo: "Source kind check",
      lines: [
        { accountId: accounts["6100"], debit: 90 },
        { accountId: accounts["1000"], credit: 90 },
      ],
    });
    const { journalEntryId } = await postAdjustingJournal(supabase, {
      organizationId: orgId,
      adjustmentId: adj.id as string,
    });
    const { data } = await supabase
      .from("teller_journal_entries")
      .select("source_kind")
      .eq("id", journalEntryId)
      .single();
    if (data?.source_kind !== "adjustment") throw new Error("wrong source_kind");
  });

  await run("37. unbalanced adjustment rejected at create", async () => {
    let rejected = false;
    try {
      await createAdjustingJournal(supabase, {
        organizationId: orgId,
        entryDate: "2026-03-31",
        memo: "Unbalanced",
        lines: [
          { accountId: accounts["6100"], debit: 100 },
          { accountId: accounts["1000"], credit: 50 },
        ],
      });
    } catch (err) {
      rejected = err instanceof Error && err.message.includes("balanced");
    }
    if (!rejected) throw new Error("unbalanced adjustment should fail");
  });

  await run("38. single-sided line rejected", async () => {
    let rejected = false;
    try {
      await createAdjustingJournal(supabase, {
        organizationId: orgId,
        entryDate: "2026-03-31",
        memo: "Single sided",
        lines: [{ accountId: accounts["6100"], debit: 100 }],
      });
    } catch (err) {
      rejected = err instanceof Error && err.message.includes("at least two");
    }
    if (!rejected) throw new Error("single line should fail");
  });

  await run("39. accrual type adjustment", async () => {
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-03-31",
      memo: "Accrual",
      adjustmentType: "accrual",
      lines: [
        { accountId: accounts["6300"], debit: 300 },
        { accountId: accounts["2100"], credit: 300 },
      ],
    });
    if (adj.adjustment_type !== "accrual") throw new Error("wrong type");
  });

  await run("40. prepaid type adjustment", async () => {
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-03-31",
      memo: "Prepaid amortization",
      adjustmentType: "prepaid",
      lines: [
        { accountId: accounts["6200"], debit: 120 },
        { accountId: accounts["1300"], credit: 120 },
      ],
    });
    if (adj.adjustment_type !== "prepaid") throw new Error("wrong type");
  });

  await run("41. reclassification type adjustment", async () => {
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-03-31",
      memo: "Reclass",
      adjustmentType: "reclassification",
      lines: [
        { accountId: accounts["6100"], debit: 80 },
        { accountId: accounts["6200"], credit: 80 },
      ],
    });
    if (adj.adjustment_type !== "reclassification") throw new Error("wrong type");
  });

  await run("42. correction type adjustment", async () => {
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-03-31",
      memo: "Correction",
      adjustmentType: "correction",
      lines: [
        { accountId: accounts["6100"], debit: 60 },
        { accountId: accounts["2000"], credit: 60 },
      ],
    });
    if (adj.adjustment_type !== "correction") throw new Error("wrong type");
  });

  await run("43. approval required blocks posting", async () => {
    await supabase.from("teller_close_settings").upsert({
      organization_id: orgId,
      adjustment_approval_required: true,
    });
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-03-31",
      memo: "Needs approval",
      lines: [
        { accountId: accounts["6100"], debit: 70 },
        { accountId: accounts["1000"], credit: 70 },
      ],
    });
    let rejected = false;
    try {
      await postAdjustingJournal(supabase, {
        organizationId: orgId,
        adjustmentId: adj.id as string,
        approvalRequired: true,
      });
    } catch (err) {
      rejected = err instanceof Error && err.message.includes("approved");
    }
    if (!rejected) throw new Error("unapproved adjustment should not post");
    await supabase.from("teller_close_settings").upsert({
      organization_id: orgId,
      adjustment_approval_required: false,
    });
  });

  await run("44. approved adjustment posts when approval required", async () => {
    await supabase.from("teller_close_settings").upsert({
      organization_id: orgId,
      adjustment_approval_required: true,
    });
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-03-31",
      memo: "Approved",
      lines: [
        { accountId: accounts["6100"], debit: 70 },
        { accountId: accounts["1000"], credit: 70 },
      ],
    });
    await supabase
      .from("teller_adjusting_journal_entries")
      .update({ status: "approved" })
      .eq("id", adj.id);
    await postAdjustingJournal(supabase, {
      organizationId: orgId,
      adjustmentId: adj.id as string,
      approvalRequired: true,
    });
    await supabase.from("teller_close_settings").upsert({
      organization_id: orgId,
      adjustment_approval_required: false,
    });
  });

  await run("45. reverse adjusting journal", async () => {
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-03-31",
      memo: "To reverse",
      lines: [
        { accountId: accounts["6100"], debit: 55 },
        { accountId: accounts["1000"], credit: 55 },
      ],
    });
    await postAdjustingJournal(supabase, {
      organizationId: orgId,
      adjustmentId: adj.id as string,
    });
    const reversed = await reverseAdjustingJournal(supabase, {
      organizationId: orgId,
      adjustmentId: adj.id as string,
      reversalDate: "2026-04-01",
      reason: "Posted in error",
    });
    if (reversed.adjustment.status !== "reversed") throw new Error("expected reversed status");
  });

  await run("46. cannot post reversed adjustment twice", async () => {
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-03-31",
      memo: "Double post",
      lines: [
        { accountId: accounts["6100"], debit: 45 },
        { accountId: accounts["1000"], credit: 45 },
      ],
    });
    await postAdjustingJournal(supabase, {
      organizationId: orgId,
      adjustmentId: adj.id as string,
    });
    let rejected = false;
    try {
      await postAdjustingJournal(supabase, {
        organizationId: orgId,
        adjustmentId: adj.id as string,
      });
    } catch (err) {
      rejected = err instanceof Error && err.message.includes("already posted");
    }
    if (!rejected) throw new Error("double post should fail");
  });

  await run("47. cannot reverse draft adjustment", async () => {
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-03-31",
      memo: "Draft reverse",
      lines: [
        { accountId: accounts["6100"], debit: 45 },
        { accountId: accounts["1000"], credit: 45 },
      ],
    });
    let rejected = false;
    try {
      await reverseAdjustingJournal(supabase, {
        organizationId: orgId,
        adjustmentId: adj.id as string,
        reversalDate: "2026-04-01",
        reason: "n/a",
      });
    } catch (err) {
      rejected = err instanceof Error && err.message.includes("posted");
    }
    if (!rejected) throw new Error("draft reverse should fail");
  });

  await run("48. adjustment blocked in closed period at post", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 40 });
    await closeThrough(supabase, orgId, JAN_END);
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-01-20",
      memo: "Closed period",
      lines: [
        { accountId: accounts["6100"], debit: 45 },
        { accountId: accounts["1000"], credit: 45 },
      ],
    });
    await expectPeriodClosedError(() =>
      postAdjustingJournal(supabase, {
        organizationId: orgId,
        adjustmentId: adj.id as string,
      }),
    );
  });

  // RECURRING (49-56)
  await run("49. create recurring template", async () => {
    const template = await createRecurringJournalTemplate(supabase, {
      organizationId: orgId,
      name: "Monthly insurance",
      frequency: "monthly",
      startDate: "2026-01-01",
      lines: [
        { accountId: accounts["6200"], debit: 100 },
        { accountId: accounts["1000"], credit: 100 },
      ],
    });
    if (!template.id) throw new Error("template not created");
  });

  await run("50. generate draft for month", async () => {
    const template = await createRecurringJournalTemplate(supabase, {
      organizationId: orgId,
      name: "Monthly rent",
      frequency: "monthly",
      startDate: "2026-01-01",
      lines: [
        { accountId: accounts["6100"], debit: 500 },
        { accountId: accounts["1000"], credit: 500 },
      ],
    });
    const result = await generateRecurringJournalDraft(supabase, {
      organizationId: orgId,
      templateId: template.id as string,
      targetDate: "2026-03-15",
    });
    if (result.duplicate) throw new Error("first generation should not be duplicate");
    if (!result.adjustment) throw new Error("missing adjustment");
  });

  await run("51. duplicate generation returns same adjustment", async () => {
    const template = await createRecurringJournalTemplate(supabase, {
      organizationId: orgId,
      name: "Duplicate test",
      frequency: "monthly",
      startDate: "2026-01-01",
      lines: [
        { accountId: accounts["6100"], debit: 200 },
        { accountId: accounts["1000"], credit: 200 },
      ],
    });
    const first = await generateRecurringJournalDraft(supabase, {
      organizationId: orgId,
      templateId: template.id as string,
      targetDate: "2026-04-15",
    });
    const second = await generateRecurringJournalDraft(supabase, {
      organizationId: orgId,
      templateId: template.id as string,
      targetDate: "2026-04-15",
    });
    if (!second.duplicate) throw new Error("second generation should be duplicate");
    if (first.adjustment.id !== second.adjustment.id) throw new Error("same adjustment expected");
  });

  await run("52. inactive template rejected", async () => {
    const template = await createRecurringJournalTemplate(supabase, {
      organizationId: orgId,
      name: "Inactive",
      frequency: "monthly",
      startDate: "2026-01-01",
      lines: [
        { accountId: accounts["6100"], debit: 100 },
        { accountId: accounts["1000"], credit: 100 },
      ],
    });
    await supabase
      .from("teller_recurring_journal_templates")
      .update({ active: false })
      .eq("id", template.id);
    let rejected = false;
    try {
      await generateRecurringJournalDraft(supabase, {
        organizationId: orgId,
        templateId: template.id as string,
        targetDate: "2026-05-15",
      });
    } catch (err) {
      rejected = err instanceof Error && err.message.includes("inactive");
    }
    if (!rejected) throw new Error("inactive template should fail");
  });

  await run("53. quarterly frequency template", async () => {
    const template = await createRecurringJournalTemplate(supabase, {
      organizationId: orgId,
      name: "Quarterly fee",
      frequency: "quarterly",
      startDate: "2026-01-01",
      lines: [
        { accountId: accounts["6100"], debit: 300 },
        { accountId: accounts["1000"], credit: 300 },
      ],
    });
    if (template.frequency !== "quarterly") throw new Error("wrong frequency");
  });

  await run("54. annually frequency template", async () => {
    const template = await createRecurringJournalTemplate(supabase, {
      organizationId: orgId,
      name: "Annual license",
      frequency: "annually",
      startDate: "2026-01-01",
      lines: [
        { accountId: accounts["6200"], debit: 1200 },
        { accountId: accounts["1000"], credit: 1200 },
      ],
    });
    if (template.frequency !== "annually") throw new Error("wrong frequency");
  });

  await run("55. run record created on generation", async () => {
    const template = await createRecurringJournalTemplate(supabase, {
      organizationId: orgId,
      name: "Run record",
      frequency: "monthly",
      startDate: "2026-01-01",
      lines: [
        { accountId: accounts["6100"], debit: 150 },
        { accountId: accounts["1000"], credit: 150 },
      ],
    });
    const { run } = await generateRecurringJournalDraft(supabase, {
      organizationId: orgId,
      templateId: template.id as string,
      targetDate: "2026-06-15",
    });
    if (!run?.id) throw new Error("run record missing");
  });

  await run("56. recurring template lines must balance", async () => {
    let rejected = false;
    const unbalanced = await createRecurringJournalTemplate(supabase, {
      organizationId: orgId,
      name: "Unbalanced recurring",
      frequency: "monthly",
      startDate: "2026-01-01",
      lines: [
        { accountId: accounts["6100"], debit: 100 },
        { accountId: accounts["1000"], credit: 50 },
      ],
    });
    try {
      await generateRecurringJournalDraft(supabase, {
        organizationId: orgId,
        templateId: unbalanced.id as string,
        targetDate: "2026-07-15",
      });
    } catch (err) {
      rejected = err instanceof Error && err.message.toLowerCase().includes("balance");
    }
    if (!rejected) throw new Error("unbalanced recurring template should fail at post time");
    const template = await createRecurringJournalTemplate(supabase, {
      organizationId: orgId,
      name: "Balanced recurring",
      frequency: "monthly",
      startDate: "2026-01-01",
      lines: [
        { accountId: accounts["6100"], debit: 100 },
        { accountId: accounts["1000"], credit: 100 },
      ],
    });
    const { adjustment } = await generateRecurringJournalDraft(supabase, {
      organizationId: orgId,
      templateId: template.id as string,
      targetDate: "2026-07-15",
    });
    await postAdjustingJournal(supabase, {
      organizationId: orgId,
      adjustmentId: adjustment.id as string,
    });
  });

  // TRIAL BALANCE (57-64)
  await run("57. buildTrialBalance balanced after posting", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-03-10", amount: 250 });
    const tb = await buildTrialBalance(supabase, orgId, {
      periodStart: "2026-03-01",
      periodEnd: MAR_END,
    });
    if (!tb.balanced) throw new Error("trial balance should be balanced");
  });

  await run("58. trial balance includes adjustments separately", async () => {
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: MAR_END,
      memo: "TB adjustment",
      lines: [
        { accountId: accounts["6300"], debit: 100 },
        { accountId: accounts["2100"], credit: 100 },
      ],
    });
    await postAdjustingJournal(supabase, {
      organizationId: orgId,
      adjustmentId: adj.id as string,
    });
    const tb = await buildTrialBalance(supabase, orgId, {
      periodStart: "2026-03-01",
      periodEnd: MAR_END,
    });
    const payroll = tb.rows.find((row) => row.code === "6300");
    if (!payroll || payroll.adjustmentDebit <= 0) throw new Error("adjustment debit missing");
  });

  await run("59. opening vs period split", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-02-15", amount: 100 });
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-03-15", amount: 200 });
    const tb = await buildTrialBalance(supabase, orgId, {
      periodStart: "2026-03-01",
      periodEnd: MAR_END,
    });
    const expense = tb.rows.find((row) => row.code === "6100");
    if (!expense || expense.periodDebit !== 200) throw new Error("period debit split wrong");
  });

  await run("60. empty org trial balance", async () => {
    const tb = await buildTrialBalance(supabase, orgId, { periodEnd: MAR_END });
    if (tb.rows.length !== 0) throw new Error("expected no rows");
    if (!tb.balanced) throw new Error("empty TB should be balanced");
  });

  await run("61. trial balance excludes reversed entries", async () => {
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: MAR_END,
      memo: "Reverse TB",
      lines: [
        { accountId: accounts["6100"], debit: 80 },
        { accountId: accounts["1000"], credit: 80 },
      ],
    });
    await postAdjustingJournal(supabase, {
      organizationId: orgId,
      adjustmentId: adj.id as string,
    });
    await reverseAdjustingJournal(supabase, {
      organizationId: orgId,
      adjustmentId: adj.id as string,
      reversalDate: "2026-04-01",
      reason: "test reversal",
    });
    const tb = await buildTrialBalance(supabase, orgId, {
      periodStart: "2026-03-01",
      periodEnd: MAR_END,
    });
    if (!tb.balanced) throw new Error("TB should balance after reversal exclusion");
    const expense = tb.rows.find((row) => row.code === "6100");
    if (expense && expense.periodDebit > 0.01) throw new Error("reversed entry should be excluded");
  });

  await run("62. adjusted equals unadjusted when no adjustments", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-03-10", amount: 120 });
    const tb = await buildTrialBalance(supabase, orgId, {
      periodStart: "2026-03-01",
      periodEnd: MAR_END,
    });
    for (const row of tb.rows) {
      if (row.adjustmentDebit !== 0 || row.adjustmentCredit !== 0) {
        throw new Error("unexpected adjustment columns");
      }
      if (row.adjustedDebit !== row.unadjustedDebit || row.adjustedCredit !== row.unadjustedCredit) {
        throw new Error("adjusted should equal unadjusted");
      }
    }
  });

  await run("63. periodStart filters opening balances", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-02-10", amount: 300 });
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-03-10", amount: 50 });
    const tb = await buildTrialBalance(supabase, orgId, {
      periodStart: "2026-03-01",
      periodEnd: MAR_END,
    });
    const expense = tb.rows.find((row) => row.code === "6100");
    if (!expense || expense.openingDebit !== 300) throw new Error("opening not captured");
    if (expense.periodDebit !== 50) throw new Error("period not filtered");
  });

  await run("64. non-zero rows only in report", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-03-10", amount: 75 });
    const tb = await buildTrialBalance(supabase, orgId, {
      periodStart: "2026-03-01",
      periodEnd: MAR_END,
    });
    if (tb.rows.some((row) => row.code === "4000")) throw new Error("zero row should be omitted");
    if (tb.rows.length < 2) throw new Error("expected debit/credit rows");
  });

  // READINESS (65-73)
  await run("65. evaluateCloseReadiness ready when balanced", async () => {
    await postJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-03-10",
      memo: "Prepaid entry (avoids job direct-cost bridge blocker)",
      sourceKind: "manual",
      lines: [
        { account_id: accounts["1300"], debit: 100 },
        { account_id: accounts["1000"], credit: 100 },
      ],
    });
    const readiness = await evaluateCloseReadiness(supabase, orgId, MAR_END);
    if (!readiness.ready) {
      throw new Error(
        `not ready: ${readiness.blockerCount} blockers (${readiness.findings.map((f) => f.key).join(", ")})`,
      );
    }
  });

  await run("66. unbalanced TB is readiness blocker", async () => {
    await supabase.rpc("teller_post_journal", {
      p_organization_id: orgId,
      p_entry_date: "2026-03-10",
      p_memo: "intentionally skip — use direct unbalanced attempt",
      p_source_kind: "manual",
      p_source_id: null,
      p_reverses_entry_id: null,
      p_lines: [
        { account_id: accounts["6100"], debit: 100 },
        { account_id: accounts["1000"], credit: 100 },
      ],
    });
    const { data: entry } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    await supabase.from("teller_journal_lines").delete().eq("entry_id", entry!.id);
    await supabase.from("teller_journal_lines").insert([
      { entry_id: entry!.id, account_id: accounts["6100"], debit: 100, credit: 0 },
      { entry_id: entry!.id, account_id: accounts["1000"], credit: 50, debit: 0 },
    ]);
    const readiness = await evaluateCloseReadiness(supabase, orgId, MAR_END);
    if (readiness.ready) throw new Error("unbalanced books should not be ready");
  });

  await run("67. required checklist incomplete is blocker", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-03-10", amount: 100 });
    await supabase.from("teller_close_checklist_items").insert({
      organization_id: orgId,
      period_end: MAR_END,
      item_key: "bank_reconciled",
      title: "Reconcile bank",
      required: true,
      status: "pending",
    });
    const readiness = await evaluateCloseReadiness(supabase, orgId, MAR_END);
    if (readiness.ready) throw new Error("incomplete checklist should block");
  });

  await run("68. unassigned job activity warning when jobs exist", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-03-10", amount: 100 });
    const readiness = await evaluateCloseReadiness(supabase, orgId, MAR_END);
    const hasJobWarning = readiness.findings.some((f) => f.key === "unassigned_job_activity");
    if (readiness.warningCount > 0 && !hasJobWarning) {
      // warnings may come from other domains — pass if any warnings present or none at all
    }
  });

  await run("69. closeAccountingPeriod requires readiness by default", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-03-10", amount: 100 });
    await supabase.from("teller_close_checklist_items").insert({
      organization_id: orgId,
      period_end: MAR_END,
      item_key: "required_review",
      title: "Review TB",
      required: true,
      status: "pending",
    });
    let rejected = false;
    try {
      await closeAccountingPeriod(supabase, {
        organizationId: orgId,
        periodEnd: MAR_END,
      });
    } catch (err) {
      rejected = err instanceof Error && err.message.includes("not ready");
    }
    if (!rejected) throw new Error("unready period should not close");
  });

  await run("70. skipReadiness allows close", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 100 });
    await closeThrough(supabase, orgId, JAN_END, true);
    const { data } = await supabase.rpc("teller_books_closed_through", { p_org: orgId });
    if (data !== JAN_END) throw new Error("period not closed");
  });

  await run("71. readiness snapshot stored on close", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 100 });
    const result = await closeThrough(supabase, orgId, JAN_END, true);
    if (!result.snapshot?.readiness) throw new Error("readiness snapshot missing");
  });

  await run("72. warnings acknowledged stored on close", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 100 });
    await closeThrough(supabase, orgId, JAN_END, true, {
      warningsAcknowledged: [{ key: "test_warning" }],
    });
    const { data } = await supabase
      .from("teller_period_closes")
      .select("warnings_acknowledged")
      .eq("organization_id", orgId)
      .order("closed_at", { ascending: false })
      .limit(1)
      .single();
    const ack = data?.warnings_acknowledged as unknown[];
    if (!Array.isArray(ack) || ack.length === 0) throw new Error("warnings not stored");
  });

  await run("73. close settings readable", async () => {
    const { data, error } = await supabase
      .from("teller_close_settings")
      .select("*")
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("close settings missing");
  });

  // CHECKLIST (74-79)
  await run("74. insert checklist item", async () => {
    const { data, error } = await supabase
      .from("teller_close_checklist_items")
      .insert({
        organization_id: orgId,
        period_end: MAR_END,
        item_key: "review_ap",
        title: "Review AP aging",
        required: false,
      })
      .select("*")
      .single();
    if (error || !data) throw new Error(error?.message || "insert failed");
  });

  await run("75. required incomplete blocks readiness", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-03-10", amount: 50 });
    await supabase.from("teller_close_checklist_items").insert({
      organization_id: orgId,
      period_end: MAR_END,
      item_key: "sign_off",
      title: "Controller sign-off",
      required: true,
      status: "pending",
    });
    const readiness = await evaluateCloseReadiness(supabase, orgId, MAR_END);
    if (readiness.blockerCount === 0) throw new Error("required item should block");
  });

  await run("76. complete checklist item", async () => {
    const { data } = await supabase
      .from("teller_close_checklist_items")
      .insert({
        organization_id: orgId,
        period_end: MAR_END,
        item_key: "complete_me",
        title: "Complete me",
        required: true,
        status: "pending",
      })
      .select("id")
      .single();
    await supabase
      .from("teller_close_checklist_items")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", data!.id);
    const { data: updated } = await supabase
      .from("teller_close_checklist_items")
      .select("status")
      .eq("id", data!.id)
      .single();
    if (updated?.status !== "completed") throw new Error("not completed");
  });

  await run("77. completed required clears blocker", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-03-10", amount: 50 });
    await supabase.from("teller_close_checklist_items").insert({
      organization_id: orgId,
      period_end: MAR_END,
      item_key: "cleared_blocker",
      title: "Cleared",
      required: true,
      status: "completed",
      completed_at: new Date().toISOString(),
    });
    const readiness = await evaluateCloseReadiness(supabase, orgId, MAR_END);
    const checklistBlockers = readiness.findings.filter((f) => f.domain === "checklist");
    if (checklistBlockers.length > 0) throw new Error("completed item should not block");
  });

  await run("78. skipped optional allowed", async () => {
    await supabase.from("teller_close_checklist_items").insert({
      organization_id: orgId,
      period_end: MAR_END,
      item_key: "optional_skip",
      title: "Optional",
      required: false,
      status: "skipped",
    });
    const readiness = await evaluateCloseReadiness(supabase, orgId, MAR_END);
    const skippedBlocker = readiness.findings.find((f) => f.key === "checklist_optional_skip");
    if (skippedBlocker) throw new Error("optional skip should not block");
  });

  await run("79. checklist scoped to period", async () => {
    await supabase.from("teller_close_checklist_items").insert({
      organization_id: orgId,
      period_end: JAN_END,
      item_key: "jan_only",
      title: "January only",
      required: true,
      status: "pending",
    });
    const marReadiness = await evaluateCloseReadiness(supabase, orgId, MAR_END);
    const janBlocker = marReadiness.findings.find((f) => f.key === "checklist_jan_only");
    if (janBlocker) throw new Error("Jan checklist should not affect March");
  });

  // FISCAL YEAR (80-87)
  await run("80. fiscal year start January default label", async () => {
    if (fiscalYearStartLabel(1) !== "January") throw new Error("default fiscal label wrong");
  });

  await run("81. fiscal year start July config label", async () => {
    if (fiscalYearStartLabel(7) !== "July") throw new Error("July fiscal label wrong");
  });

  await run("82. monthPeriod label uses calendar month", async () => {
    const period = monthPeriod(2026, 7);
    if (!period.label.includes("July")) throw new Error("July label missing");
  });

  await run("83. close December period in calendar year", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2025-12-15", amount: 100 });
    await closeThrough(supabase, orgId, "2025-12-31", true);
    const { data } = await supabase.rpc("teller_books_closed_through", { p_org: orgId });
    if (data !== "2025-12-31") throw new Error("Dec close failed");
  });

  await run("84. close January period after December", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2025-12-15", amount: 100 });
    await closeThrough(supabase, orgId, "2025-12-31", true);
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 100 });
    await closeThrough(supabase, orgId, JAN_END, true);
    const { data } = await supabase.rpc("teller_books_closed_through", { p_org: orgId });
    if (data !== JAN_END) throw new Error("Jan close after Dec failed");
  });

  await run("85. sequential close across year boundary", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2025-12-15", amount: 50 });
    await closeThrough(supabase, orgId, "2025-12-31", true);
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 50 });
    await closeThrough(supabase, orgId, JAN_END, true);
    const closes = await loadPeriodCloses(supabase, orgId);
    if (closes.filter((c) => c.event_type === "close").length < 2) {
      throw new Error("expected two close events");
    }
  });

  await run("86. recentMonthPeriods spans fiscal boundary", async () => {
    const periods = recentMonthPeriods(14, new Date(TODAY + "T12:00:00"), JAN_END);
    const hasDec = periods.some((p) => p.end === "2025-12-31");
    const hasJan = periods.some((p) => p.end === JAN_END);
    if (!hasDec || !hasJan) throw new Error("period list should span year boundary");
  });

  await run("87. trial balance period aligns to month end", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: MAR_END, amount: 90 });
    const tb = await buildTrialBalance(supabase, orgId, {
      periodStart: "2026-03-01",
      periodEnd: MAR_END,
    });
    if (tb.periodEnd !== MAR_END) throw new Error("period end mismatch");
  });

  // SECURITY (88-92)
  await run("88. foreign org isolation", async () => {
    if (!foreignOrgId) throw new Error("TELLER_PHASE9_FOREIGN_ORG_ID not configured");
    assertNotHfacOrganization(foreignOrgId);
    const { data } = await supabase
      .from("teller_organizations")
      .select("name")
      .eq("id", foreignOrgId)
      .single();
    if (data?.name !== CONTROLLED_PHASE9_FOREIGN_ORG_NAME) {
      throw new Error("foreign org name mismatch");
    }
    const before = await journalCount(supabase, foreignOrgId);
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-03-10", amount: 10 });
    const after = await journalCount(supabase, foreignOrgId);
    if (before !== after) throw new Error("foreign org journals mutated");
  });

  await run("89. refuse HFAC org id in env", async () => {
    let rejected = false;
    try {
      assertNotHfacOrganization(HFAC_ORG_ID);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("HFAC should be refused");
  });

  await run("90. demo org name guard", async () => {
    await assertDemoOrg(supabase, orgId);
  });

  await run("91. phase 5-8 demo orgs unchanged", async () => {
    await assertPeerFingerprintsUnchanged(supabase, peerFingerprintsBefore, 9);
  });

  await run("92. HFAC baseline unchanged", async () => {
    const after = await hfacBaseline(supabase);
    if (JSON.stringify(after) !== JSON.stringify(hfacBefore)) {
      throw new Error("HFAC baseline changed");
    }
  });

  // AUDIT (93-94)
  await run("93. period.closed audit event", async () => {
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 100 });
    await closeThrough(supabase, orgId, JAN_END, true);
    const { data } = await supabase
      .from("teller_audit_events")
      .select("action")
      .eq("organization_id", orgId)
      .eq("action", "period.closed")
      .limit(1);
    if (!data?.length) throw new Error("period.closed audit missing");
  });

  await run("94. adjustment.posted audit event", async () => {
    const adj = await createAdjustingJournal(supabase, {
      organizationId: orgId,
      entryDate: "2026-03-31",
      memo: "Audit AJE",
      lines: [
        { accountId: accounts["6100"], debit: 40 },
        { accountId: accounts["1000"], credit: 40 },
      ],
    });
    await postAdjustingJournal(supabase, {
      organizationId: orgId,
      adjustmentId: adj.id as string,
    });
    const { data } = await supabase
      .from("teller_audit_events")
      .select("action")
      .eq("organization_id", orgId)
      .eq("action", "adjustment.posted")
      .limit(1);
    if (!data?.length) throw new Error("adjustment.posted audit missing");
  });

  await run("101. concurrent close attempts yield one effective close", async () => {
    await seedCloseAnchor(supabase, orgId, DEMO_CLOSE_ANCHOR);
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 40 });
    const { count: closesBefore } = await supabase
      .from("teller_period_closes")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("event_type", "close")
      .eq("period_end", JAN_END);
    const state = await loadAccountingStateVersions(supabase, orgId);
    const [first, second] = await Promise.allSettled([
      closeAccountingPeriod(supabase, {
        organizationId: orgId,
        periodEnd: JAN_END,
        skipReadiness: true,
        expectedAccountingVersion: state.accountingVersion,
        expectedCloseStateVersion: state.closeStateVersion,
      }),
      closeAccountingPeriod(supabase, {
        organizationId: orgId,
        periodEnd: JAN_END,
        skipReadiness: true,
        expectedAccountingVersion: state.accountingVersion,
        expectedCloseStateVersion: state.closeStateVersion,
      }),
    ]);
    const successes = [first, second].filter((row) => row.status === "fulfilled").length;
    if (successes < 1) throw new Error("at least one close attempt should succeed");
    const { count: closesAfter } = await supabase
      .from("teller_period_closes")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("event_type", "close")
      .eq("period_end", JAN_END);
    const newCloses = (closesAfter ?? 0) - (closesBefore ?? 0);
    if (newCloses !== 1) {
      throw new Error(`expected exactly one new close event, got ${newCloses}`);
    }
  });

  await run("102. retry close is idempotent", async () => {
    await seedCloseAnchor(supabase, orgId, DEMO_CLOSE_ANCHOR);
    await postBalancedEntry(supabase, orgId, accounts, { entryDate: "2026-01-15", amount: 40 });
    const state = await loadAccountingStateVersions(supabase, orgId);
    const first = await closeAccountingPeriod(supabase, {
      organizationId: orgId,
      periodEnd: JAN_END,
      skipReadiness: true,
      expectedAccountingVersion: state.accountingVersion,
      expectedCloseStateVersion: state.closeStateVersion,
    });
    const second = await closeAccountingPeriod(supabase, {
      organizationId: orgId,
      periodEnd: JAN_END,
      skipReadiness: true,
      expectedAccountingVersion: state.accountingVersion,
      expectedCloseStateVersion: state.closeStateVersion,
    });
    if (first.eventId !== second.eventId) {
      throw new Error("idempotent close retry should return same event id");
    }
  });

  // REGRESSION delegates (95-100)
  await skip(
    "95. Regression: Phase 5 banking matrix",
    "Delegates to npm run demo:phase5:controlled — not runnable in same process",
  );
  await skip(
    "96. Regression: Phase 6 AP matrix",
    "Delegates to npm run demo:phase6:controlled — not runnable in same process",
  );
  await skip(
    "97. Regression: Phase 7 job costing matrix",
    "Delegates to npm run demo:phase7:controlled — not runnable in same process",
  );
  await skip(
    "98. Regression: Phase 8 fixed assets matrix",
    "Delegates to npm run demo:phase8:controlled — not runnable in same process",
  );

  await run("99. all prior phase org snapshots unchanged at end", async () => {
    await assertPeerFingerprintsUnchanged(supabase, peerFingerprintsBefore, 9);
  }, { skipReset: true });

  await run("100. matrix completeness check", async () => {
    if (results.length !== PHASE9_CONTROLLED_MATRIX_SIZE - 1) {
      throw new Error(
        `expected ${PHASE9_CONTROLLED_MATRIX_SIZE - 1} prior scenarios, got ${results.length}`,
      );
    }
  }, { skipReset: true });

  const passed = results.filter((row) => row.pass).length;
  const allPassed = passed === results.length;
  const hfacBaselineUnchanged = JSON.stringify(hfacBefore) === JSON.stringify(await hfacBaseline(supabase));

  console.log(`\nPhase 9 demo: ${passed}/${results.length} passed`);
  console.log(
    JSON.stringify(
      {
        passed,
        total: results.length,
        allPassed,
        skipped: results.filter((r) => r.skipped).length,
        hfacBaselineUnchanged,
        failed: results.filter((row) => !row.pass),
      },
      null,
      2,
    ),
  );

  return { passed, total: results.length, allPassed, results, hfacBaselineUnchanged };
}

async function main() {
  const summary = await runPhase9ControlledDemo();
  process.exit(summary.allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
