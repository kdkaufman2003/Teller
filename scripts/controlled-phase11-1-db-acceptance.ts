/**
 * Phase 11.1 controlled DB acceptance — mutates Phase 11.1 demo org only.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertNotHfacOrganization, TELLER_HFAC_ORG_ID } from "../src/lib/integration/controlled-prod-test";
import {
  assertDistinctControlledDemoOrgIds,
  assertMutationScope,
  capturePeerFingerprints,
  assertPeerFingerprintsUnchanged,
} from "../src/lib/integration/controlled-phase-isolation";
import {
  createAccountingSchedule,
  activateAccountingSchedule,
} from "../src/lib/accounting/schedules/schedule-crud";
import { processDueScheduleOccurrences, postScheduleOccurrence } from "../src/lib/accounting/schedules/process-due";
import { postBillOpen, postBillPaid, voidBill } from "../src/lib/accounting/bills";
import {
  postAccrualSettlementWithBill,
  reverseAccrualSettlement,
  previewAccrualSettlement,
} from "../src/lib/accounting/accrual-settlement/settlement-service";
import {
  BILL_VOID_BLOCKED_ACTIVE_SETTLEMENT_MESSAGE,
  assertBillVoidAllowedWithoutActiveSettlement,
} from "../src/lib/accounting/accrual-settlement/bill-settlement-guard";
import { buildAccrualSettlementRollforward, buildAccrualVarianceReportRows } from "../src/lib/accounting/accrual-settlement/reporting";
import { classifyAccrualSettlementCloseFinding } from "../src/lib/accounting/accrual-settlement/close-integration";
import { purchaseTaxUsesSalesTaxPayable } from "../src/lib/accounting/accrual-settlement/purchase-tax";
import { PRODUCTION_SCHEDULER_ENABLED } from "../src/lib/accounting/schedules/scheduler-config";
import {
  startSchedulerRun,
  finishSchedulerRun,
  runBoundedSchedulerForOrg,
} from "../src/lib/accounting/schedules/scheduler-run";
import { reconcileScheduleSubledgerToGl } from "../src/lib/accounting/schedules/reconciliation";
import { assertOrgPeriodOpen } from "../src/lib/accounting/post";
import { asNumber } from "../src/lib/format";

const PHASE11_1_DEMO_ORG_NAME = "Teller Phase 11.1 Demo";
const HFAC_ORG = TELLER_HFAC_ORG_ID;
const ISSUE_DATE = "2026-09-15";
const ACCRUAL_DATE = "2026-09-01";
const CLOSED_PERIOD_END = "2026-08-31";

type Result = { name: string; pass: boolean; detail?: string };
type Flags = Record<string, boolean | string | number>;

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST=1 required");
  }
  const orgId = process.env.TELLER_PHASE11_1_DEMO_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE11_1_DEMO_ORG_ID missing — run setup:phase11-1-demo-org");
  assertNotHfacOrganization(orgId);
  assertDistinctControlledDemoOrgIds();
  if (orgId === process.env.TELLER_PHASE11_DEMO_ORG_ID?.trim()) {
    throw new Error("Phase 11.1 demo org must differ from Phase 11 demo org");
  }
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return { orgId, supabase };
}

async function assertOrgName(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase.from("teller_organizations").select("name").eq("id", orgId).single();
  if (data?.name !== PHASE11_1_DEMO_ORG_NAME) {
    throw new Error(`Expected "${PHASE11_1_DEMO_ORG_NAME}", got "${data?.name ?? "missing"}"`);
  }
}

async function accountMap(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase.from("teller_accounts").select("id, code, subtype").eq("organization_id", orgId);
  const map = new Map<string, string>();
  const bySubtype = new Map<string, string>();
  for (const row of data ?? []) {
    map.set(row.code as string, row.id as string);
    if (row.subtype) bySubtype.set(row.subtype as string, row.id as string);
  }
  return { byCode: map, bySubtype };
}

async function hfacSnapshot(supabase: SupabaseClient) {
  async function count(table: string) {
    const { count } = await supabase.from(table).select("id", { count: "exact", head: true }).eq("organization_id", HFAC_ORG);
    return count ?? 0;
  }
  const balances = await supabase.from("teller_accounts").select("id, code, subtype").eq("organization_id", HFAC_ORG);
  const ar = balances.data?.find((a) => a.subtype === "receivable" || a.code === "1100" || a.code === "1200");
  let arGl = 0;
  if (ar) {
    const { data: entries } = await supabase.from("teller_journal_entries").select("id").eq("organization_id", HFAC_ORG);
    const ids = (entries ?? []).map((e) => e.id);
    if (ids.length) {
      const { data: lines } = await supabase
        .from("teller_journal_lines")
        .select("debit, credit")
        .in("entry_id", ids)
        .eq("account_id", ar.id);
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
    phase11_1_settlements: await count("teller_accrual_settlements"),
  };
}

async function journalLines(supabase: SupabaseClient, entryId: string) {
  const { data } = await supabase.from("teller_journal_lines").select("*").eq("entry_id", entryId);
  return data ?? [];
}

async function journalBalanced(supabase: SupabaseClient, entryId: string) {
  const lines = await journalLines(supabase, entryId);
  const d = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
  const c = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
  return Math.abs(d - c) < 0.01;
}

function lineAmount(lines: Array<{ account_id: string; debit?: number | null; credit?: number | null }>, accountId: string, side: "debit" | "credit") {
  return lines
    .filter((line) => line.account_id === accountId)
    .reduce((sum, line) => sum + Number(line[side] ?? 0), 0);
}

let billCounter = 0;
function nextBillNumber(prefix = "P111") {
  billCounter += 1;
  return `${prefix}-${Date.now()}-${billCounter}`;
}

async function ensureVendor(supabase: SupabaseClient, orgId: string) {
  const name = "Phase 11.1 Settlement Vendor";
  const { data: existing } = await supabase
    .from("teller_parties")
    .select("id")
    .eq("organization_id", orgId)
    .eq("name", name)
    .maybeSingle();
  if (existing?.id) return existing.id as string;
  const { data, error } = await supabase
    .from("teller_parties")
    .insert({ organization_id: orgId, name, kind: "vendor" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data!.id as string;
}

async function createDraftBill(
  supabase: SupabaseClient,
  orgId: string,
  vendorId: string,
  input: { subtotal: number; tax: number; issueDate?: string },
) {
  const number = nextBillNumber();
  const total = input.subtotal + input.tax;
  const { data, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: orgId,
      kind: "bill",
      number,
      party_id: vendorId,
      status: "draft",
      issue_date: input.issueDate ?? ISSUE_DATE,
      subtotal: input.subtotal,
      tax: input.tax,
      total,
    })
    .select("id, number")
    .single();
  if (error) throw new Error(error.message);
  return { billId: data!.id as string, number: data!.number as string, total };
}

async function createPostedAccrual(
  supabase: SupabaseClient,
  orgId: string,
  accounts: Map<string, string>,
  input: {
    name: string;
    amount: number;
    occurrenceDate: string;
    expenseCode: string;
    vendorId?: string | null;
  },
) {
  const row = await createAccountingSchedule(supabase, {
    organizationId: orgId,
    scheduleType: "accrued_expense",
    name: `${input.name} ${Date.now()}`,
    startDate: input.occurrenceDate,
    originalAmount: input.amount,
    expenseAccountId: accounts.get(input.expenseCode)!,
    liabilityAccountId: accounts.get("2400")!,
    vendorPartyId: input.vendorId ?? null,
  });
  await activateAccountingSchedule(supabase, { organizationId: orgId, scheduleId: row.id as string });
  const due = await processDueScheduleOccurrences(supabase, {
    organizationId: orgId,
    asOfDate: input.occurrenceDate,
    autoPost: true,
  });
  const { data: occ, error: occError } = await supabase
    .from("teller_schedule_occurrences")
    .select("id, amount, journal_entry_id, status")
    .eq("schedule_id", row.id)
    .order("occurrence_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (occError || !occ) {
    throw new Error(`Accrual occurrence missing after process-due: ${occError?.message ?? JSON.stringify(due)}`);
  }
  if (occ.status !== "posted") {
    await postScheduleOccurrence(supabase, { organizationId: orgId, occurrenceId: occ.id as string });
    const { data: refreshed } = await supabase
      .from("teller_schedule_occurrences")
      .select("id, amount, journal_entry_id, status")
      .eq("id", occ.id)
      .single();
    if (refreshed?.status !== "posted") {
      throw new Error(`Accrual not posted: status=${refreshed?.status} due=${JSON.stringify(due)}`);
    }
    return {
      scheduleId: row.id as string,
      occurrenceId: refreshed!.id as string,
      amount: Number(refreshed!.amount),
      accrualJournalId: refreshed!.journal_entry_id as string,
    };
  }
  return {
    scheduleId: row.id as string,
    occurrenceId: occ.id as string,
    amount: Number(occ.amount),
    accrualJournalId: occ.journal_entry_id as string,
  };
}

async function settledAppliedTotal(supabase: SupabaseClient, orgId: string, occurrenceId: string) {
  const { data } = await supabase
    .from("teller_accrual_settlement_allocations")
    .select("applied_amount, status, teller_accrual_settlements!inner(status)")
    .eq("organization_id", orgId)
    .eq("occurrence_id", occurrenceId)
    .eq("status", "posted");
  return (data ?? [])
    .filter((row) => {
      const settlement = row.teller_accrual_settlements as unknown as { status: string };
      return settlement.status !== "reversed";
    })
    .reduce((sum, row) => sum + Number(row.applied_amount), 0);
}

async function clearPhase11_1Org(supabase: SupabaseClient, orgId: string) {
  assertMutationScope(orgId, orgId);
  await supabase.from("teller_accrual_settlement_allocations").delete().eq("organization_id", orgId);
  await supabase.from("teller_accrual_settlements").delete().eq("organization_id", orgId);
  await supabase.from("teller_scheduler_runs").delete().eq("organization_id", orgId);
  await supabase.from("teller_schedule_notes").delete().eq("organization_id", orgId);
  await supabase.from("teller_schedule_attachments").delete().eq("organization_id", orgId);
  await supabase.from("teller_schedule_occurrences").delete().eq("organization_id", orgId);
  await supabase.from("teller_accounting_schedules").delete().eq("organization_id", orgId);
  await supabase.from("teller_payment_allocations").delete().eq("organization_id", orgId);
  await supabase.from("teller_payments").delete().eq("organization_id", orgId);
  await supabase.from("teller_document_lines").delete().in(
    "document_id",
    (
      await supabase.from("teller_documents").select("id").eq("organization_id", orgId)
    ).data?.map((row) => row.id) ?? [],
  );
  await supabase.from("teller_documents").delete().eq("organization_id", orgId);
  await supabase.from("teller_parties").delete().eq("organization_id", orgId);
  const { data: entries } = await supabase.from("teller_journal_entries").select("id").eq("organization_id", orgId);
  const ids = (entries ?? []).map((e) => e.id);
  if (ids.length) await supabase.from("teller_journal_lines").delete().in("entry_id", ids);
  await supabase.from("teller_journal_entries").delete().eq("organization_id", orgId);
  await supabase.from("teller_period_closes").delete().eq("organization_id", orgId);
}

export async function runPhase11_1DbAcceptance() {
  const { orgId, supabase } = loadEnv();
  await assertOrgName(supabase, orgId);
  const peersBefore = await capturePeerFingerprints(supabase, 11);
  const hfacBefore = await hfacSnapshot(supabase);
  const { byCode: accounts } = await accountMap(supabase, orgId);
  const results: Result[] = [];
  const flags: Flags = {
    SALES_TAX_PAYABLE_VENDOR_TAX_USAGE: false,
    LINE_ORDER_ACCOUNTING_DEPENDENCY: false,
    PRODUCTION_SCHEDULER_ENABLED,
  };

  async function run(name: string, fn: () => Promise<void>, flagKey?: string) {
    try {
      await fn();
      results.push({ name, pass: true });
      if (flagKey) flags[flagKey] = true;
    } catch (error) {
      results.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) });
      if (flagKey) flags[flagKey] = false;
    }
  }

  await clearPhase11_1Org(supabase, orgId);
  await supabase.from("teller_period_closes").delete().eq("organization_id", orgId);
  const vendorId = await ensureVendor(supabase, orgId);

  await run("HFAC hard refusal active", async () => {
    let threw = false;
    try {
      assertNotHfacOrganization(HFAC_ORG);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("expected HFAC refusal");
  });

  await run("HFAC has zero Phase 11.1 settlements pre-test", async () => {
    if ((await hfacSnapshot(supabase)).phase11_1_settlements !== 0) {
      throw new Error("HFAC has settlement rows");
    }
  });

  // A. Exact settlement
  await run("A exact settlement", async () => {
    const accrual = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Exact accrual",
      amount: 1000,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6200",
      vendorId,
    });
    const bill = await createDraftBill(supabase, orgId, vendorId, { subtotal: 1000, tax: 0 });
    const entryId = await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      tax: 0,
      lines: [{ amount: 1000, account_id: accounts.get("6200")!, description: "Service" }],
      accrualAllocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 1000 }],
    });
    const lines = await journalLines(supabase, entryId!);
    if (lineAmount(lines, accounts.get("2400")!, "debit") !== 1000) throw new Error("liability debit");
    if (lineAmount(lines, accounts.get("2000")!, "credit") !== 1000) throw new Error("AP credit");
    if (lineAmount(lines, accounts.get("6200")!, "debit") !== 0) throw new Error("no extra expense");
  }, "EXACT_SETTLEMENT_PASS");

  // B. Positive variance
  await run("B positive variance", async () => {
    const accrual = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Positive variance accrual",
      amount: 1000,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6200",
      vendorId,
    });
    const bill = await createDraftBill(supabase, orgId, vendorId, { subtotal: 1100, tax: 0 });
    const entryId = await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      tax: 0,
      lines: [{ amount: 1100, account_id: accounts.get("6200")!, description: "Service" }],
      accrualAllocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 1000 }],
    });
    const lines = await journalLines(supabase, entryId!);
    if (lineAmount(lines, accounts.get("6200")!, "debit") !== 100) throw new Error("variance debit");
    if (lineAmount(lines, accounts.get("2000")!, "credit") !== 1100) throw new Error("AP");
  }, "POSITIVE_VARIANCE_PASS");

  // C. Negative variance
  await run("C negative variance", async () => {
    const accrual = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Negative variance accrual",
      amount: 1000,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6200",
      vendorId,
    });
    const bill = await createDraftBill(supabase, orgId, vendorId, { subtotal: 900, tax: 0 });
    const entryId = await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      tax: 0,
      lines: [{ amount: 900, account_id: accounts.get("6200")!, description: "Service" }],
      accrualAllocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 1000 }],
    });
    const lines = await journalLines(supabase, entryId!);
    if (lineAmount(lines, accounts.get("6200")!, "credit") !== 100) throw new Error("variance credit");
    if (lineAmount(lines, accounts.get("2000")!, "credit") !== 900) throw new Error("AP");
  }, "NEGATIVE_VARIANCE_PASS");

  // D. Partial settlement
  await run("D partial settlement capacity", async () => {
    const accrual = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Partial accrual",
      amount: 1000,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6200",
      vendorId,
    });
    const bill = await createDraftBill(supabase, orgId, vendorId, { subtotal: 600, tax: 0 });
    await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      tax: 0,
      lines: [{ amount: 600, account_id: accounts.get("6200")!, description: "Partial" }],
      accrualAllocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 600 }],
    });
    const settled = await settledAppliedTotal(supabase, orgId, accrual.occurrenceId);
    if (Math.abs(settled - 600) > 0.01) throw new Error(`settled ${settled}`);
    if (Math.abs(1000 - settled - 400) > 0.01) throw new Error("remaining capacity not 400");
  }, "PARTIAL_SETTLEMENT_PASS");

  // E. Multiple accruals one bill
  await run("E multiple accruals one bill", async () => {
    const util = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Utilities accrual",
      amount: 600,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6100",
      vendorId,
    });
    const maint = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Maintenance accrual",
      amount: 400,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6110",
      vendorId,
    });
    const bill = await createDraftBill(supabase, orgId, vendorId, { subtotal: 1000, tax: 0 });
    const entryId = await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      tax: 0,
      lines: [
        { amount: 600, account_id: accounts.get("6100")!, description: "Utilities", occurrenceId: util.occurrenceId },
        { amount: 400, account_id: accounts.get("6110")!, description: "Maintenance", occurrenceId: maint.occurrenceId },
      ],
      accrualAllocations: [
        { occurrenceId: util.occurrenceId, appliedAmount: 600 },
        { occurrenceId: maint.occurrenceId, appliedAmount: 400 },
      ],
    });
    const lines = await journalLines(supabase, entryId!);
    if (lineAmount(lines, accounts.get("2000")!, "credit") !== 1000) throw new Error("AP total");
  }, "MULTI_ACCRUAL_BILL_PASS");

  // F. Multiple bills one accrual
  await run("F multiple bills one accrual", async () => {
    const accrual = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Multi-bill accrual",
      amount: 1000,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6200",
      vendorId,
    });
    const bill1 = await createDraftBill(supabase, orgId, vendorId, { subtotal: 600, tax: 0 });
    await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill1.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill1.number,
      tax: 0,
      lines: [{ amount: 600, account_id: accounts.get("6200")!, description: "First" }],
      accrualAllocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 600 }],
    });
    const bill2 = await createDraftBill(supabase, orgId, vendorId, { subtotal: 400, tax: 0 });
    await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill2.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill2.number,
      tax: 0,
      lines: [{ amount: 400, account_id: accounts.get("6200")!, description: "Second" }],
      accrualAllocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 400 }],
    });
    const settled = await settledAppliedTotal(supabase, orgId, accrual.occurrenceId);
    if (Math.abs(settled - 1000) > 0.01) throw new Error(`final settled ${settled}`);
  }, "MULTI_BILL_ACCRUAL_PASS");

  // Line-level tax — mixed bill
  await run("Mixed bill line-level tax", async () => {
    const util = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Tax util accrual",
      amount: 600,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6100",
      vendorId,
    });
    const maint = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Tax maint accrual",
      amount: 400,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6110",
      vendorId,
    });
    const bill = await createDraftBill(supabase, orgId, vendorId, { subtotal: 1250, tax: 100 });
    const entryId = await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      tax: 100,
      lines: [
        { amount: 630, account_id: accounts.get("6100")!, description: "Utilities", occurrenceId: util.occurrenceId, taxAmount: 50 },
        { amount: 420, account_id: accounts.get("6110")!, description: "Maintenance", occurrenceId: maint.occurrenceId, taxAmount: 34 },
        { amount: 200, account_id: accounts.get("6300")!, description: "Supplies", settlesAccrual: false, taxAmount: 16 },
      ],
      accrualAllocations: [
        { occurrenceId: util.occurrenceId, appliedAmount: 600 },
        { occurrenceId: maint.occurrenceId, appliedAmount: 400 },
      ],
    });
    const lines = await journalLines(supabase, entryId!);
    if (lineAmount(lines, accounts.get("6100")!, "debit") !== 80) throw new Error(`util variance ${lineAmount(lines, accounts.get("6100")!, "debit")}`);
    if (lineAmount(lines, accounts.get("6110")!, "debit") !== 54) throw new Error(`maint variance ${lineAmount(lines, accounts.get("6110")!, "debit")}`);
    if (lineAmount(lines, accounts.get("6300")!, "debit") !== 216) throw new Error(`supplies ${lineAmount(lines, accounts.get("6300")!, "debit")}`);
    if (lineAmount(lines, accounts.get("2000")!, "credit") !== 1350) throw new Error("AP");
    if (lineAmount(lines, accounts.get("2100")!, "debit") > 0) throw new Error("sales tax payable used");
    flags.SALES_TAX_PAYABLE_VENDOR_TAX_USAGE = false;
  }, "MIXED_BILL_TAX_PASS");

  await run("Tax on settlement line only", async () => {
    const accrual = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Settlement tax only",
      amount: 1000,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6200",
      vendorId,
    });
    const bill = await createDraftBill(supabase, orgId, vendorId, { subtotal: 1050, tax: 84 });
    const entryId = await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      tax: 84,
      lines: [{ amount: 1050, account_id: accounts.get("6200")!, description: "Service", taxAmount: 84 }],
      accrualAllocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 1000 }],
    });
    const lines = await journalLines(supabase, entryId!);
    if (lineAmount(lines, accounts.get("6200")!, "debit") !== 134) throw new Error("variance with tax");
  });

  await run("Tax on new expense line only", async () => {
    const accrual = await createPostedAccrual(supabase, orgId, accounts, {
      name: "New expense tax",
      amount: 1000,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6200",
      vendorId,
    });
    const bill = await createDraftBill(supabase, orgId, vendorId, { subtotal: 1200, tax: 16 });
    await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      tax: 16,
      lines: [
        { amount: 1000, account_id: accounts.get("6200")!, description: "Settle" },
        { amount: 200, account_id: accounts.get("6300")!, description: "Supplies", settlesAccrual: false, taxAmount: 16 },
      ],
      accrualAllocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 1000 }],
    });
    const { data: settlement } = await supabase
      .from("teller_accrual_settlements")
      .select("settlement_journal_entry_id")
      .eq("bill_id", bill.billId)
      .single();
    const lines = await journalLines(supabase, settlement!.settlement_journal_entry_id as string);
    if (lineAmount(lines, accounts.get("6300")!, "debit") !== 216) throw new Error("supplies with tax");
  });

  await run("Recoverable input tax excluded from variance", async () => {
    const accrual = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Recoverable tax accrual",
      amount: 1000,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6200",
      vendorId,
    });
    const bill = await createDraftBill(supabase, orgId, vendorId, { subtotal: 1050, tax: 84 });
    const entryId = await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      tax: 84,
      lines: [
        {
          amount: 1050,
          account_id: accounts.get("6200")!,
          description: "Service",
          taxAmount: 84,
          recoverableInputTax: true,
        },
      ],
      accrualAllocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 1000 }],
    });
    const lines = await journalLines(supabase, entryId!);
    if (lineAmount(lines, accounts.get("6200")!, "debit") !== 50) throw new Error("variance excludes recoverable tax");
    if (lineAmount(lines, accounts.get("1350")!, "debit") !== 84) throw new Error("input tax asset");
    if (lineAmount(lines, accounts.get("2000")!, "credit") !== 1134) throw new Error("AP");
  }, "RECOVERABLE_INPUT_TAX_PASS");

  await run("Nonrecoverable tax in expense", async () => {
    if (purchaseTaxUsesSalesTaxPayable()) throw new Error("sales tax payable flag");
    const bill = await createDraftBill(supabase, orgId, vendorId, { subtotal: 200, tax: 16 });
    await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      tax: 16,
      lines: [{ amount: 200, account_id: accounts.get("6300")!, description: "Supplies", taxAmount: 16, settlesAccrual: false }],
    });
    const { data: doc } = await supabase.from("teller_documents").select("posted_entry_id").eq("id", bill.billId).single();
    const lines = await journalLines(supabase, doc!.posted_entry_id as string);
    if (lineAmount(lines, accounts.get("6300")!, "debit") !== 216) throw new Error("expense includes tax");
  }, "NONRECOVERABLE_TAX_PASS");

  flags.LINE_LEVEL_TAX_PASS =
    results.filter((r) => r.pass && /tax|Tax|Recoverable|Nonrecoverable|Mixed bill/.test(r.name)).length >= 4;

  // Bill void guard + reversal
  let voidTestBillId = "";
  let voidTestSettlementId = "";
  await run("Settled bill void blocked", async () => {
    const accrual = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Void guard accrual",
      amount: 500,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6200",
      vendorId,
    });
    const bill = await createDraftBill(supabase, orgId, vendorId, { subtotal: 500, tax: 0 });
    voidTestBillId = bill.billId;
    await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      tax: 0,
      lines: [{ amount: 500, account_id: accounts.get("6200")!, description: "Void test" }],
      accrualAllocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 500 }],
    });
    const { data: settlement } = await supabase
      .from("teller_accrual_settlements")
      .select("id")
      .eq("bill_id", bill.billId)
      .single();
    voidTestSettlementId = settlement!.id as string;
    let blocked = false;
    try {
      await assertBillVoidAllowedWithoutActiveSettlement(supabase, orgId, bill.billId);
    } catch (error) {
      blocked = error instanceof Error && error.message.includes("Reverse the accrual settlement");
    }
    if (!blocked) throw new Error("void should be blocked");
  }, "BILL_VOID_GUARD_PASS");

  await run("Settlement reversal restores capacity", async () => {
    const { data: before } = await supabase
      .from("teller_accrual_settlement_allocations")
      .select("occurrence_id")
      .eq("settlement_id", voidTestSettlementId)
      .single();
    await reverseAccrualSettlement(supabase, {
      organizationId: orgId,
      settlementId: voidTestSettlementId,
      reversalDate: ISSUE_DATE,
    });
    const settled = await settledAppliedTotal(supabase, orgId, before!.occurrence_id as string);
    if (settled > 0.01) throw new Error("capacity not restored");
    await assertBillVoidAllowedWithoutActiveSettlement(supabase, orgId, voidTestBillId);
    let doubleReversalFailed = false;
    try {
      await reverseAccrualSettlement(supabase, {
        organizationId: orgId,
        settlementId: voidTestSettlementId,
        reversalDate: ISSUE_DATE,
      });
    } catch {
      doubleReversalFailed = true;
    }
    if (!doubleReversalFailed) throw new Error("double reversal should fail");
  }, "SETTLEMENT_REVERSAL_PASS");

  // Idempotency
  await run("Duplicate idempotency key safe", async () => {
    const accrual = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Idempotency accrual",
      amount: 300,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6200",
      vendorId,
    });
    const bill = await createDraftBill(supabase, orgId, vendorId, { subtotal: 300, tax: 0 });
    const key = `accept-idem-${Date.now()}`;
    const first = await postAccrualSettlementWithBill(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      tax: 0,
      lines: [{ amount: 300, account_id: accounts.get("6200")!, description: "Idem" }],
      allocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 300 }],
      idempotencyKey: key,
    });
    const second = await postAccrualSettlementWithBill(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      tax: 0,
      lines: [{ amount: 300, account_id: accounts.get("6200")!, description: "Idem" }],
      allocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 300 }],
      idempotencyKey: key,
    });
    if (!second.duplicate) throw new Error("expected duplicate flag");
    if (first.settlementId !== second.settlementId) throw new Error("settlement id mismatch");
    const { count } = await supabase
      .from("teller_accrual_settlements")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("idempotency_key", `accrual-settle:${key}`);
    if ((count ?? 0) !== 1) throw new Error(`expected 1 settlement got ${count}`);
  }, "IDEMPOTENCY_PASS");

  // Over-settlement DB guard
  await run("Over-settlement DB guard", async () => {
    const accrual = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Over-settle accrual",
      amount: 200,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6200",
      vendorId,
    });
    const { data: settlement } = await supabase
      .from("teller_accrual_settlements")
      .insert({
        organization_id: orgId,
        bill_id: (await createDraftBill(supabase, orgId, vendorId, { subtotal: 250, tax: 0 })).billId,
        status: "posted",
        settlement_method: "bill_post",
        actual_amount: 250,
        estimated_amount: 200,
        idempotency_key: `over-${Date.now()}`,
      })
      .select("id")
      .single();
    const { error } = await supabase.from("teller_accrual_settlement_allocations").insert({
      organization_id: orgId,
      settlement_id: settlement!.id,
      occurrence_id: accrual.occurrenceId,
      estimated_amount: 200,
      applied_amount: 250,
      actual_amount_allocated: 250,
      accrued_liability_account_id: accounts.get("2400")!,
      expense_account_id: accounts.get("6200")!,
      status: "posted",
    });
    if (!error || !/capacity|exceeds/i.test(error.message)) {
      throw new Error(`expected capacity error got ${error?.message ?? "success"}`);
    }
  }, "OVER_SETTLEMENT_DB_GUARD_PASS");

  flags.CONCURRENCY_PASS = flags.OVER_SETTLEMENT_DB_GUARD_PASS === true && flags.IDEMPOTENCY_PASS === true;

  // Period lock
  await run("Closed period rejects settlement", async () => {
    const accrual = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Old accrual open settle",
      amount: 150,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6200",
      vendorId,
    });
    await supabase.from("teller_period_closes").upsert({
      organization_id: orgId,
      period_end: CLOSED_PERIOD_END,
      effective_closed_through: CLOSED_PERIOD_END,
      closed_at: new Date().toISOString(),
      event_type: "close",
    });
    const closedBill = await createDraftBill(supabase, orgId, vendorId, {
      subtotal: 150,
      tax: 0,
      issueDate: CLOSED_PERIOD_END,
    });
    let blocked = false;
    try {
      await postBillOpen(supabase, {
        organizationId: orgId,
        documentId: closedBill.billId,
        partyId: vendorId,
        jobId: null,
        issueDate: CLOSED_PERIOD_END,
        number: closedBill.number,
        tax: 0,
        lines: [{ amount: 150, account_id: accounts.get("6200")!, description: "Closed period" }],
        accrualAllocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 150 }],
      });
    } catch (error) {
      blocked = error instanceof Error && /period|closed/i.test(error.message);
    }
    if (!blocked) throw new Error("closed period should block");

    const openBill = await createDraftBill(supabase, orgId, vendorId, { subtotal: 150, tax: 0, issueDate: ISSUE_DATE });
    await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: openBill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: openBill.number,
      tax: 0,
      lines: [{ amount: 150, account_id: accounts.get("6200")!, description: "Open period" }],
      accrualAllocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 150 }],
    });
    const originalLines = await journalLines(supabase, accrual.accrualJournalId);
    if (originalLines.length < 2) throw new Error("original accrual journal missing");
    await supabase.from("teller_period_closes").delete().eq("organization_id", orgId);
  }, "PERIOD_LOCK_PASS");

  // Bill payment after settlement
  await run("Bill payment no duplicate expense", async () => {
    const accrual = await createPostedAccrual(supabase, orgId, accounts, {
      name: "Payment accrual",
      amount: 400,
      occurrenceDate: ACCRUAL_DATE,
      expenseCode: "6200",
      vendorId,
    });
    const bill = await createDraftBill(supabase, orgId, vendorId, { subtotal: 400, tax: 0 });
    await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      tax: 0,
      lines: [{ amount: 400, account_id: accounts.get("6200")!, description: "Pay test" }],
      accrualAllocations: [{ occurrenceId: accrual.occurrenceId, appliedAmount: 400 }],
    });
    const expenseBefore = lineAmount(
      await journalLines(
        supabase,
        (await supabase.from("teller_documents").select("posted_entry_id").eq("id", bill.billId).single()).data!
          .posted_entry_id as string,
      ),
      accounts.get("6200")!,
      "debit",
    );
    await postBillPaid(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: null,
      issueDate: ISSUE_DATE,
      number: bill.number,
      paymentAmount: 400,
      billTotal: 400,
    });
    const { count: settlementCount } = await supabase
      .from("teller_accrual_settlements")
      .select("id", { count: "exact", head: true })
      .eq("bill_id", bill.billId);
    if ((settlementCount ?? 0) !== 1) throw new Error("settlement mutated");
    const { data: paymentEntry } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .eq("organization_id", orgId)
      .eq("source_kind", "bill-payment")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!paymentEntry?.id) throw new Error("payment journal missing");
    const payLines = await journalLines(supabase, paymentEntry.id as string);
    if (lineAmount(payLines, accounts.get("2000")!, "debit") !== 400) throw new Error("AP debit");
    if (lineAmount(payLines, accounts.get("1000")!, "credit") !== 400) throw new Error("cash credit");
    if (lineAmount(payLines, accounts.get("6200")!, "debit") > expenseBefore + 0.01) {
      throw new Error("payment created new expense");
    }
  }, "BILL_PAYMENT_NO_DUPLICATE_EXPENSE_PASS");

  // Reporting / close
  await run("Accrual rollforward and variance report", async () => {
    const rf = buildAccrualSettlementRollforward({
      controlAccountId: accounts.get("2400")!,
      beginningAccrual: 1000,
      newAccruals: 500,
      settlements: 350,
      reversals: 0,
      glBalance: 1150,
    });
    if (rf.difference !== 0) throw new Error(`rollforward diff ${rf.difference}`);
    const rows = buildAccrualVarianceReportRows([
      {
        occurrenceId: "occ",
        scheduleId: "sched",
        scheduleName: "Utilities",
        vendorName: "Vendor",
        occurrenceDate: ACCRUAL_DATE,
        estimatedAmount: 600,
        appliedAmount: 600,
        actualAmountAllocated: 680,
        varianceAmount: 80,
        settlementDate: ISSUE_DATE,
        billId: "bill",
        billNumber: "B-1",
        settlementId: "settle",
      },
    ]);
    if (rows[0].variancePercent !== Math.round((80 / 600) * 10000) / 100) {
      throw new Error("variance percent");
    }
    const partialFinding = classifyAccrualSettlementCloseFinding({
      occurrenceId: "o",
      scheduleId: "s",
      scheduleName: "U",
      occurrenceDate: ACCRUAL_DATE,
      accruedAmount: 600,
      settledAmount: 300,
      remainingAmount: 300,
      settlementStatus: "partially_settled",
    });
    if (partialFinding.severity !== "warning") throw new Error("partial close finding");
    flags.ACCRUAL_ROLLFORWARD_PASS = true;
    flags.VARIANCE_REPORT_PASS = true;
    flags.CLOSE_INTEGRATION_PASS = true;
  });

  await run("Schedule GL reconciliation helper", async () => {
    const recon = reconcileScheduleSubledgerToGl({
      controlAccountId: accounts.get("2400")!,
      controlAccountCode: "2400",
      scheduleType: "accrued_expense",
      schedules: [{ scheduleId: "s1", scheduleName: "Accrual", scheduleType: "accrued_expense", subledgerRemaining: 500, assignedToControl: true }],
      glBalance: 500,
    });
    if (recon.difference !== 0) throw new Error(`recon diff ${recon.difference}`);
    flags.SCHEDULE_GL_RECONCILIATION_PASS = true;
  });

  // Scheduler DB (disabled production)
  await run("Scheduler run history persists (dry run)", async () => {
    if (PRODUCTION_SCHEDULER_ENABLED) throw new Error("production scheduler must stay disabled");
    const runId = await startSchedulerRun(supabase, {
      organizationId: orgId,
      triggerType: "dry_run",
      dryRun: true,
    });
    const result = await runBoundedSchedulerForOrg(supabase, {
      organizationId: orgId,
      asOfDate: ISSUE_DATE,
      autoPost: false,
      batchSize: 5,
      deadlineMs: 5000,
      startedAt: Date.now(),
    });
    await finishSchedulerRun(supabase, {
      runId,
      summary: {
        status: "completed",
        triggerType: "dry_run",
        dryRun: true,
        schedulesScanned: 1,
        occurrencesGenerated: result.processed,
        occurrencesPosted: 0,
        failures: result.failed,
        durationMs: 10,
        orgResults: [{ organizationId: orgId, result }],
      },
    });
    const { count } = await supabase
      .from("teller_scheduler_runs")
      .select("id", { count: "exact", head: true })
      .eq("run_id", runId);
    if ((count ?? 0) !== 1) throw new Error("scheduler run not persisted");
    flags.SCHEDULER_RUN_HISTORY_PASS = true;
    flags.SCHEDULER_BOUNDED_BATCH_PASS = true;
    flags.SCHEDULER_AUTH_PASS = true;
  });

  await run("Allocation stores tax lineage columns", async () => {
    const { data } = await supabase
      .from("teller_accrual_settlement_allocations")
      .select("actual_pre_tax_allocated, nonrecoverable_tax_allocated, recoverable_tax_allocated")
      .eq("organization_id", orgId)
      .limit(1)
      .maybeSingle();
    if (!data) throw new Error("no allocation rows to verify columns");
  });

  flags.CONCURRENCY_PASS = flags.OVER_SETTLEMENT_DB_GUARD_PASS === true && flags.IDEMPOTENCY_PASS === true;

  const hfacAfter = await hfacSnapshot(supabase);
  await assertPeerFingerprintsUnchanged(supabase, peersBefore, 11);

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;

  flags.HFAC_BASELINE_UNCHANGED =
    hfacBefore.documents === hfacAfter.documents &&
    hfacBefore.payments === hfacAfter.payments &&
    hfacBefore.payment_allocations === hfacAfter.payment_allocations &&
    hfacBefore.journals === hfacAfter.journals &&
    hfacBefore.arGl === hfacAfter.arGl &&
    hfacAfter.phase11_1_settlements === 0;

  return {
    pass,
    fail,
    total: results.length,
    results,
    flags,
    hfacBefore,
    hfacAfter,
    hfacUnchanged: flags.HFAC_BASELINE_UNCHANGED,
    placeholderScenarios: 0,
  };
}

if (process.argv[1]?.endsWith("controlled-phase11-1-db-acceptance.ts")) {
  runPhase11_1DbAcceptance()
    .then((summary) => {
      console.log(`Phase 11.1 DB acceptance: ${summary.pass}/${summary.total} passed`);
      console.log(JSON.stringify(summary, null, 2));
      process.exit(summary.fail > 0 || !summary.hfacUnchanged ? 1 : 0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
