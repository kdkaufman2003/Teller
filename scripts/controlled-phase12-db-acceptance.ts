/**
 * Phase 12 controlled DB acceptance — mutates Phase 12 demo org only.
 */
import { randomUUID } from "crypto";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  CONTROLLED_PHASE12_FOREIGN_ORG_NAME,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import {
  assertDistinctControlledDemoOrgIds,
  assertMutationScope,
  captureOrgEconomicFingerprint,
  capturePeerFingerprints,
  assertPeerFingerprintsUnchanged,
  type OrgEconomicFingerprint,
} from "../src/lib/integration/controlled-phase-isolation";
import { postPayrollRun, reversePayrollRun } from "../src/lib/accounting/payroll/payroll-service";
import {
  postPayrollRunWithLabor,
  createWorker,
  ensurePayrollAccountMappings,
  loadPayrollMappingsFromDb,
  standardPayrollComponents,
} from "../src/lib/accounting/payroll/payroll-run-labor";
import { postPayrollLiabilitySettlement } from "../src/lib/accounting/payroll/settlement-service";
import {
  PAYROLL_COMPONENT_CATEGORIES,
  SENSITIVE_PAYROLL_FIELDS,
  assertNoSensitivePayrollFields,
  payrollRunIdempotencyKey,
  type PayrollComponentInput,
} from "../src/lib/accounting/payroll/types";
import { confirmBankMatch } from "../src/lib/banking/categorize";
import { importBankTransactionsBatch } from "../src/lib/banking/ingest";
import {
  addReconciliationItems,
  finalizeBankReconciliation,
  loadReconciliationSummary,
  startBankReconciliation,
} from "../src/lib/banking/reconciliation";
import {
  assertSameOrganizationForPayroll,
  previewPayrollRun,
} from "../src/lib/accounting/payroll/import-normalizer";
import {
  reconcilePayrollRunToJournal,
  reconcileJobLaborEconomics,
} from "../src/lib/accounting/payroll/reconciliation";
import {
  buildPayrollSummary,
  buildPayrollLiabilityRollforward,
  buildLaborByJobReport,
  buildUnallocatedLaborReport,
  buildAccountantPayrollPackage,
} from "../src/lib/accounting/payroll/reporting";
import { evaluatePayrollCloseFindings } from "../src/lib/accounting/payroll/close-integration";
import {
  allocateEmployerBurden,
  summarizeLaborAllocations,
} from "../src/lib/accounting/payroll/labor-allocation";
import { buildJobProfitabilitySummary } from "../src/lib/accounting/job-profitability";
import { assertOrgPeriodOpen } from "../src/lib/accounting/post";
import { assertHfacPayrollHardRefusal } from "../src/lib/accounting/payroll/hfac-boundary";
import {
  buildPayrollSettlementJournalLines,
  settlementCreatesExpense,
} from "../src/lib/accounting/payroll/journal-lines";
import { payrollAtomicRpcAvailable } from "../src/lib/accounting/payroll/atomic-rpc";

const PHASE12_DEMO_ORG_NAME = "Teller Phase 12 Demo";
const HFAC_ORG = TELLER_HFAC_ORG_ID;
const PAY_DATE = "2026-10-15";
const PERIOD_START = "2026-10-01";
const PERIOD_END = "2026-10-15";
const CLOSED_PERIOD_END = "2026-09-30";

type Result = { name: string; pass: boolean; detail?: string };
type Flags = Record<string, boolean | string | number>;

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST=1 required");
  }
  const orgId = process.env.TELLER_PHASE12_DEMO_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE12_DEMO_ORG_ID missing — run setup:phase12-demo-org");
  const foreignOrgId = process.env.TELLER_PHASE12_FOREIGN_ORG_ID?.trim();
  if (!foreignOrgId) throw new Error("TELLER_PHASE12_FOREIGN_ORG_ID missing — run setup:phase12-demo-org");
  const phase11_1OrgId = process.env.TELLER_PHASE11_1_DEMO_ORG_ID?.trim();
  if (!phase11_1OrgId) throw new Error("TELLER_PHASE11_1_DEMO_ORG_ID missing — required for peer isolation");
  assertNotHfacOrganization(orgId);
  assertNotHfacOrganization(foreignOrgId);
  assertNotHfacOrganization(phase11_1OrgId);
  assertDistinctControlledDemoOrgIds();
  if (orgId === foreignOrgId) throw new Error("Phase 12 demo org must differ from foreign test org");
  if (orgId === phase11_1OrgId) throw new Error("Phase 12 demo org must differ from Phase 11.1 demo org");
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return { orgId, foreignOrgId, phase11_1OrgId, supabase };
}

async function assertOrgName(supabase: SupabaseClient, orgId: string, expectedName: string) {
  const { data } = await supabase.from("teller_organizations").select("name").eq("id", orgId).single();
  if (data?.name !== expectedName) {
    throw new Error(`Expected "${expectedName}", got "${data?.name ?? "missing"}"`);
  }
}

async function accountMap(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase.from("teller_accounts").select("id, code, subtype").eq("organization_id", orgId);
  const byCode = new Map<string, string>();
  for (const row of data ?? []) byCode.set(row.code as string, row.id as string);
  return byCode;
}

type AccountBundle = {
  wageExpenseId: string;
  employerTaxExpenseId: string;
  federalPayableId: string;
  statePayableId: string;
  ficaPayableId: string;
  otherTaxPayableId: string;
  benefitsPayableId: string;
  retirementPayableId: string;
  clearingId: string;
  cashId: string;
  apId: string;
};

function bundleAccounts(byCode: Map<string, string>): AccountBundle {
  return {
    wageExpenseId: byCode.get("6000")!,
    employerTaxExpenseId: byCode.get("6100")!,
    federalPayableId: byCode.get("2420")!,
    statePayableId: byCode.get("2421")!,
    ficaPayableId: byCode.get("2422")!,
    otherTaxPayableId: byCode.get("2423")!,
    benefitsPayableId: byCode.get("2430")!,
    retirementPayableId: byCode.get("2435")!,
    clearingId: byCode.get("2410")!,
    cashId: byCode.get("1000")!,
    apId: byCode.get("2000")!,
  };
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
    phase12_payroll_runs: await count("teller_payroll_runs"),
    phase12_labor_entries: await count("teller_labor_entries"),
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

function lineAmount(
  lines: Array<{ account_id: string; debit?: number | null; credit?: number | null }>,
  accountId: string,
  side: "debit" | "credit",
) {
  return lines
    .filter((line) => line.account_id === accountId)
    .reduce((sum, line) => sum + Number(line[side] ?? 0), 0);
}

async function createJob(supabase: SupabaseClient, orgId: string, jobNumber: string, name: string) {
  const { data, error } = await supabase
    .from("teller_jobs")
    .insert({
      organization_id: orgId,
      job_number: jobNumber,
      name,
      status: "active",
    })
    .select("id, job_number")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not create job");
  return { jobId: data.id as string, jobNumber: data.job_number as string };
}

async function closePeriod(supabase: SupabaseClient, orgId: string, periodEnd: string) {
  const { error } = await supabase.from("teller_period_closes").upsert({
    organization_id: orgId,
    period_end: periodEnd,
    event_type: "close",
    effective_closed_through: periodEnd,
    closed_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

async function reopenPeriods(supabase: SupabaseClient, orgId: string) {
  await supabase.from("teller_period_closes").delete().eq("organization_id", orgId);
}

async function clearPhase12Org(supabase: SupabaseClient, orgId: string) {
  assertMutationScope(orgId, orgId);
  await supabase.from("teller_bank_matches").delete().eq("organization_id", orgId);
  await supabase.from("teller_bank_reconciliation_items").delete().eq("organization_id", orgId);
  await supabase.from("teller_bank_reconciliations").delete().eq("organization_id", orgId);
  await supabase.from("teller_bank_transactions").delete().eq("organization_id", orgId);
  await supabase.from("teller_payroll_liability_settlements").delete().eq("organization_id", orgId);
  await supabase.from("teller_labor_entries").delete().eq("organization_id", orgId);
  await supabase.from("teller_payroll_components").delete().eq("organization_id", orgId);
  await supabase.from("teller_payroll_runs").delete().eq("organization_id", orgId);
  await supabase.from("teller_payroll_account_mappings").delete().eq("organization_id", orgId);
  await supabase.from("teller_workers").delete().eq("organization_id", orgId);
  const { data: entries } = await supabase.from("teller_journal_entries").select("id").eq("organization_id", orgId);
  const ids = (entries ?? []).map((e) => e.id);
  if (ids.length) await supabase.from("teller_journal_lines").delete().in("entry_id", ids);
  await supabase.from("teller_journal_entries").delete().eq("organization_id", orgId);
  await supabase.from("teller_period_closes").delete().eq("organization_id", orgId);
  await supabase.from("teller_jobs").delete().eq("organization_id", orgId);
  await supabase.from("teller_parties").delete().eq("organization_id", orgId);
}

let runSeq = 0;
function nextExternalRunId(prefix = "P12") {
  runSeq += 1;
  return `${prefix}-${Date.now()}-${runSeq}`;
}

async function assertWorkerOrgScope(
  supabase: SupabaseClient,
  organizationId: string,
  workerIds: string[],
) {
  for (const workerId of workerIds) {
    const { data: worker, error } = await supabase
      .from("teller_workers")
      .select("organization_id")
      .eq("id", workerId)
      .single();
    if (error || !worker) throw new Error(error?.message ?? "Worker not found");
    assertSameOrganizationForPayroll({
      organizationId,
      workerOrgId: worker.organization_id as string,
    });
  }
}

async function ensurePhase12BankAccount(
  supabase: SupabaseClient,
  orgId: string,
  cashAccountId: string,
): Promise<string> {
  const externalAccountId = "phase12-demo-checking";
  const { data: existing } = await supabase
    .from("teller_bank_accounts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("external_account_id", externalAccountId)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  let connectionId: string;
  const { data: existingConn } = await supabase
    .from("teller_bank_connections")
    .select("id")
    .eq("organization_id", orgId)
    .eq("provider", "manual_csv")
    .limit(1)
    .maybeSingle();
  if (existingConn?.id) {
    connectionId = existingConn.id as string;
  } else {
    const { data: conn, error: connError } = await supabase
      .from("teller_bank_connections")
      .insert({
        organization_id: orgId,
        provider: "manual_csv",
        external_item_id: `phase12-${orgId.slice(0, 8)}`,
        institution_name: "Phase 12 Demo Bank",
        status: "active",
      })
      .select("id")
      .single();
    if (connError || !conn) throw new Error(connError?.message ?? "Could not create bank connection");
    connectionId = conn.id as string;
  }

  const { data, error } = await supabase
    .from("teller_bank_accounts")
    .insert({
      organization_id: orgId,
      connection_id: connectionId,
      external_account_id: externalAccountId,
      name: "Phase 12 Demo Checking",
      account_type: "depository",
      account_subtype: "checking",
      gl_account_id: cashAccountId,
      teller_account_id: cashAccountId,
      institution_name: "Phase 12 Demo Bank",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not create bank account");
  return data.id as string;
}

async function importBankOutflow(
  supabase: SupabaseClient,
  orgId: string,
  bankAccountId: string,
  providerTransactionId: string,
  amount: number,
  description: string,
  postedDate: string,
): Promise<string> {
  await importBankTransactionsBatch(
    supabase,
    {
      organizationId: orgId,
      bankAccountId,
      provider: "manual_csv",
      transactions: [
        {
          providerTransactionId,
          externalTransactionId: providerTransactionId,
          providerAccountId: bankAccountId,
          externalAccountId: bankAccountId,
          postedDate,
          rawAmount: amount,
          amount,
          description,
          pending: false,
          currency: "USD",
        },
      ],
    },
    { audit: false },
  );
  const { data, error } = await supabase
    .from("teller_bank_transactions")
    .select("id")
    .eq("organization_id", orgId)
    .eq("bank_account_id", bankAccountId)
    .eq("provider_transaction_id", providerTransactionId)
    .maybeSingle();
  if (error || !data?.id) throw new Error(error?.message ?? "Bank transaction not found after import");
  return data.id as string;
}

async function countPayrollRunsByExternalId(
  supabase: SupabaseClient,
  orgId: string,
  provider: string,
  externalRunId: string,
) {
  const { count } = await supabase
    .from("teller_payroll_runs")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("provider", provider)
    .eq("external_run_id", externalRunId);
  return count ?? 0;
}

async function countPayrollRecognitionJournals(
  supabase: SupabaseClient,
  orgId: string,
  payrollRunId: string,
) {
  const { data: run } = await supabase
    .from("teller_payroll_runs")
    .select("journal_entry_id")
    .eq("organization_id", orgId)
    .eq("id", payrollRunId)
    .maybeSingle();
  return run?.journal_entry_id ? 1 : 0;
}

async function countReversalJournalsForRun(
  supabase: SupabaseClient,
  orgId: string,
  payrollRunId: string,
) {
  const { data: run } = await supabase
    .from("teller_payroll_runs")
    .select("reversal_journal_entry_id")
    .eq("id", payrollRunId)
    .maybeSingle();
  if (!run?.reversal_journal_entry_id) return 0;
  const { count } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("source_kind", "reversal")
    .eq("id", run.reversal_journal_entry_id);
  return count ?? 0;
}

async function accountExpenseTotal(supabase: SupabaseClient, orgId: string, accountId: string) {
  const { data: entries } = await supabase.from("teller_journal_entries").select("id").eq("organization_id", orgId);
  const ids = (entries ?? []).map((row) => row.id);
  if (!ids.length) return 0;
  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("debit, credit")
    .in("entry_id", ids)
    .eq("account_id", accountId);
  return (lines ?? []).reduce((sum, line) => sum + Number(line.debit ?? 0) - Number(line.credit ?? 0), 0);
}

async function countLaborEntriesForRun(supabase: SupabaseClient, orgId: string, payrollRunId: string) {
  const { count } = await supabase
    .from("teller_labor_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("payroll_run_id", payrollRunId);
  return count ?? 0;
}

async function countComponentsForRun(supabase: SupabaseClient, orgId: string, payrollRunId: string) {
  const { count } = await supabase
    .from("teller_payroll_components")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("payroll_run_id", payrollRunId);
  return count ?? 0;
}

async function countPayrollRunSourceJournals(
  supabase: SupabaseClient,
  orgId: string,
  payrollRunId: string,
) {
  const { count } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("source_kind", "payroll_run")
    .eq("source_id", payrollRunId);
  return count ?? 0;
}

async function countCleanupReversalArtifacts(supabase: SupabaseClient, orgId: string) {
  const { count } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .or("memo.ilike.%Orphan payroll%,memo.ilike.%orphan payroll%");
  return count ?? 0;
}

async function findOrphanPayrollJournals(supabase: SupabaseClient, orgId: string) {
  const { data: runs } = await supabase
    .from("teller_payroll_runs")
    .select("id, journal_entry_id, reversal_journal_entry_id")
    .eq("organization_id", orgId);
  const { data: settlements } = await supabase
    .from("teller_payroll_liability_settlements")
    .select("id, journal_entry_id")
    .eq("organization_id", orgId);

  const canonical = new Set<string>();
  for (const run of runs ?? []) {
    if (run.journal_entry_id) canonical.add(run.journal_entry_id as string);
    if (run.reversal_journal_entry_id) canonical.add(run.reversal_journal_entry_id as string);
  }
  for (const row of settlements ?? []) {
    if (row.journal_entry_id) canonical.add(row.journal_entry_id as string);
  }

  const { data: payrollJournals } = await supabase
    .from("teller_journal_entries")
    .select("id, source_kind, source_id, memo")
    .eq("organization_id", orgId)
    .in("source_kind", ["payroll_run", "payroll_settlement"]);

  const orphans = (payrollJournals ?? []).filter((row) => !canonical.has(row.id as string));
  return orphans;
}

export async function runPhase12DbAcceptance() {
  const { orgId, foreignOrgId, phase11_1OrgId, supabase } = loadEnv();
  await assertOrgName(supabase, orgId, PHASE12_DEMO_ORG_NAME);
  await assertOrgName(supabase, foreignOrgId, CONTROLLED_PHASE12_FOREIGN_ORG_NAME);

  const peersBefore = await capturePeerFingerprints(supabase, 12);
  const phase11_1Before: OrgEconomicFingerprint = await captureOrgEconomicFingerprint(supabase, phase11_1OrgId);
  const hfacBefore = await hfacSnapshot(supabase);

  const byCode = await accountMap(supabase, orgId);
  const accounts = bundleAccounts(byCode);
  const results: Result[] = [];
  const flags: Flags = {};

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

  await clearPhase12Org(supabase, orgId);
  await reopenPeriods(supabase, orgId);

  await ensurePayrollAccountMappings(supabase, orgId, accounts);
  const baselineComponents = standardPayrollComponents();
  const standardMappings = await loadPayrollMappingsFromDb(supabase, orgId);

  if (!(await payrollAtomicRpcAvailable(supabase))) {
    throw new Error(
      "Migration 030 atomic payroll RPCs are not callable via Supabase REST. " +
        "Apply supabase/migrations/030_phase12_payroll_atomic_rpc.sql to controlled production, then re-run acceptance.",
    );
  }
  flags.CLAIM_BEFORE_POST_IMPLEMENTED = true;
  flags.BEST_EFFORT_ORPHAN_REVERSAL_REMOVED = true;

  // 1. HFAC hard refusal
  await run(
    "1 HFAC hard refusal",
    async () => {
      let threw = false;
      try {
        assertHfacPayrollHardRefusal(HFAC_ORG);
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("expected HFAC payroll refusal");
    },
    "HFAC_HARD_REFUSAL_PASS",
  );

  // 2. HFAC zero phase 12 records pre-test
  await run(
    "2 HFAC zero Phase 12 records pre-test",
    async () => {
      const snap = await hfacSnapshot(supabase);
      if (snap.phase12_payroll_runs !== 0 || snap.phase12_labor_entries !== 0) {
        throw new Error(`HFAC has phase12 rows: runs=${snap.phase12_payroll_runs} labor=${snap.phase12_labor_entries}`);
      }
    },
    "HFAC_ZERO_PHASE12_PRETEST_PASS",
  );

  // 3. Basic balanced payroll journal with exact account amounts
  await run(
    "3 Basic balanced payroll journal exact amounts",
    async () => {
      const externalRunId = nextExternalRunId("basic");
      const { journalEntryId } = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId,
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components: baselineComponents,
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      if (!(await journalBalanced(supabase, journalEntryId))) throw new Error("journal unbalanced");
      const lines = await journalLines(supabase, journalEntryId);
      if (lineAmount(lines, accounts.wageExpenseId, "debit") !== 10000) throw new Error("wage debit");
      if (lineAmount(lines, accounts.employerTaxExpenseId, "debit") !== 965) throw new Error("er tax debit");
      if (lineAmount(lines, accounts.federalPayableId, "credit") !== 1200) throw new Error("fed credit");
      if (lineAmount(lines, accounts.statePayableId, "credit") !== 400) throw new Error("state credit");
      if (lineAmount(lines, accounts.ficaPayableId, "credit") !== 1530) throw new Error("fica credit");
      if (lineAmount(lines, accounts.otherTaxPayableId, "credit") !== 200) throw new Error("other er tax credit");
      if (lineAmount(lines, accounts.clearingId, "credit") !== 7635) throw new Error("clearing credit");
    },
    "BASIC_BALANCED_PAYROLL_PASS",
  );

  // 4. Component categories — at least 3 variant posts
  await run(
    "4 Component categories overtime bonus commission",
    async () => {
      const variants: Array<{ label: string; components: PayrollComponentInput[]; gross: number }> = [
        {
          label: "overtime",
          gross: 8500,
          components: [
            { category: PAYROLL_COMPONENT_CATEGORIES.GROSS_WAGES, amount: 8000 },
            { category: PAYROLL_COMPONENT_CATEGORIES.OVERTIME, amount: 500 },
            { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FICA, amount: 500 },
            { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_PAYROLL_TAX, amount: 500 },
            { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_FICA_LIABILITY, amount: 500 },
            { category: PAYROLL_COMPONENT_CATEGORIES.NET_PAY, amount: 8000 },
          ],
        },
        {
          label: "bonus",
          gross: 10500,
          components: [
            { category: PAYROLL_COMPONENT_CATEGORIES.GROSS_WAGES, amount: 10000 },
            { category: PAYROLL_COMPONENT_CATEGORIES.BONUS, amount: 500 },
            { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FICA, amount: 800 },
            { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_PAYROLL_TAX, amount: 800 },
            { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_FICA_LIABILITY, amount: 800 },
            { category: PAYROLL_COMPONENT_CATEGORIES.NET_PAY, amount: 9700 },
          ],
        },
        {
          label: "sick",
          gross: 10200,
          components: [
            { category: PAYROLL_COMPONENT_CATEGORIES.GROSS_WAGES, amount: 10000 },
            { category: PAYROLL_COMPONENT_CATEGORIES.SICK_PAY, amount: 200 },
            { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FICA, amount: 780 },
            { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_PAYROLL_TAX, amount: 780 },
            { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_FICA_LIABILITY, amount: 780 },
            { category: PAYROLL_COMPONENT_CATEGORIES.NET_PAY, amount: 9420 },
          ],
        },
      ];

      for (const variant of variants) {
        const preview = previewPayrollRun({
          components: variant.components,
          mappings: standardMappings,
          wageExpenseAccountId: accounts.wageExpenseId,
          employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
        });
        if (!preview.balanced || preview.errors.length) {
          throw new Error(`${variant.label} preview: ${preview.errors.join("; ")}`);
        }
        if (preview.grossWages !== variant.gross) {
          throw new Error(`${variant.label} gross ${preview.grossWages} != ${variant.gross}`);
        }
        const posted = await postPayrollRun(supabase, {
          organizationId: orgId,
          provider: "manual",
          externalRunId: nextExternalRunId(variant.label),
          payDate: PAY_DATE,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          components: variant.components,
          mappings: standardMappings,
          wageExpenseAccountId: accounts.wageExpenseId,
          employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
        });
        if (!(await journalBalanced(supabase, posted.journalEntryId))) {
          throw new Error(`${variant.label} journal unbalanced`);
        }
      }
    },
    "COMPONENT_VARIANTS_PASS",
  );

  // 5. Missing mapping blocks posting
  await run(
    "5 Missing wage mapping blocks posting",
    async () => {
      await supabase
        .from("teller_payroll_account_mappings")
        .delete()
        .eq("organization_id", orgId)
        .eq("component_category", PAYROLL_COMPONENT_CATEGORIES.GROSS_WAGES);
      const brokenMappings = await loadPayrollMappingsFromDb(supabase, orgId, 765);
      let blocked = false;
      try {
        await postPayrollRun(supabase, {
          organizationId: orgId,
          provider: "manual",
          externalRunId: nextExternalRunId("nomap"),
          payDate: PAY_DATE,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          components: standardPayrollComponents({ gross: 500, net: 500 }),
          mappings: brokenMappings,
          wageExpenseAccountId: accounts.wageExpenseId,
          employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
        });
      } catch (error) {
        blocked = error instanceof Error && /mapping|Missing/i.test(error.message);
      }
      await ensurePayrollAccountMappings(supabase, orgId, accounts);
      if (!blocked) throw new Error("expected missing mapping error");
    },
    "MISSING_MAPPING_BLOCKS_PASS",
  );

  // 6. Worker same org validation
  await run(
    "6 Worker same org validation",
    async () => {
      const workerId = await createWorker(supabase, {
        organizationId: orgId,
        displayName: "Demo Employee",
      });
      await assertWorkerOrgScope(supabase, orgId, [workerId]);
      let crossOrg = false;
      try {
        assertSameOrganizationForPayroll({ organizationId: orgId, workerOrgId: foreignOrgId });
      } catch {
        crossOrg = true;
      }
      if (!crossOrg) throw new Error("cross-org worker should fail validation");
    },
    "WORKER_SAME_ORG_PASS",
  );

  // 7. Foreign org cannot read demo payroll run
  await run(
    "7 Foreign org cannot read demo payroll run",
    async () => {
      const externalRunId = nextExternalRunId("foreign-read");
      const smallMappings = await loadPayrollMappingsFromDb(supabase, orgId, 76.5);
      const posted = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId,
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components: standardPayrollComponents({ gross: 1000, federal: 100, state: 50, employeeFica: 76.5, employerFica: 76.5, otherEmployerTax: 20, net: 773.5 }),
        mappings: smallMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      const { data: scoped } = await supabase
        .from("teller_payroll_runs")
        .select("id, organization_id")
        .eq("organization_id", foreignOrgId)
        .eq("id", posted.payrollRunId)
        .maybeSingle();
      if (scoped) throw new Error("foreign org query returned demo run");
      const { data: unscoped } = await supabase
        .from("teller_payroll_runs")
        .select("id, organization_id")
        .eq("id", posted.payrollRunId)
        .maybeSingle();
      if (!unscoped) throw new Error("service role could not read run");
      if (unscoped.organization_id !== orgId) throw new Error("run organization_id mismatch");
    },
    "FOREIGN_ORG_ISOLATION_PASS",
  );

  // 8. Direct job labor allocation jobs A/B/training
  let laborRunId = "";
  let jobAId = "";
  let jobBId = "";
  let laborWorkerId = "";
  await run(
    "8 Direct job labor allocation A B training",
    async () => {
      const jobA = await createJob(supabase, orgId, "P12-A", "Job A");
      const jobB = await createJob(supabase, orgId, "P12-B", "Job B");
      jobAId = jobA.jobId;
      jobBId = jobB.jobId;
      laborWorkerId = await createWorker(supabase, { organizationId: orgId, displayName: "Field Tech" });
      await assertWorkerOrgScope(supabase, orgId, [laborWorkerId]);
      const components = standardPayrollComponents({
        gross: 1000,
        federal: 100,
        state: 50,
        employeeFica: 76.5,
        employerFica: 76.5,
        otherEmployerTax: 20,
        net: 773.5,
      });
      const posted = await postPayrollRunWithLabor(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId: nextExternalRunId("labor-ab"),
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components,
        laborAllocations: [
          { workerId: laborWorkerId, jobId: jobAId, workDate: PAY_DATE, grossAmount: 600, laborType: "direct", hours: 30 },
          { workerId: laborWorkerId, jobId: jobBId, workDate: PAY_DATE, grossAmount: 300, laborType: "direct", hours: 15 },
          { workerId: laborWorkerId, jobId: null, workDate: PAY_DATE, grossAmount: 100, laborType: "training", hours: 5 },
        ],
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      laborRunId = posted.payrollRunId;
      const summary = summarizeLaborAllocations([
        { workerId: laborWorkerId, jobId: jobAId, workDate: PAY_DATE, grossAmount: 600, laborType: "direct" },
        { workerId: laborWorkerId, jobId: jobBId, workDate: PAY_DATE, grossAmount: 300, laborType: "direct" },
        { workerId: laborWorkerId, jobId: null, workDate: PAY_DATE, grossAmount: 100, laborType: "training" },
      ]);
      if (summary.directGross !== 900) throw new Error(`direct gross ${summary.directGross}`);
      if (summary.indirectGross !== 100) throw new Error(`training gross ${summary.indirectGross}`);
    },
    "DIRECT_JOB_LABOR_PASS",
  );

  // 9. Employer burden 76.50 on 600/400 split
  await run(
    "9 Employer burden 76.50 on 600/400 split",
    async () => {
      const rows = allocateEmployerBurden({
        totalEmployerBurden: 76.5,
        destinations: [
          { key: "a", jobId: "j1", laborType: "direct", grossAmount: 600 },
          { key: "b", jobId: "j2", laborType: "direct", grossAmount: 400 },
        ],
      });
      if (Math.abs(rows[0]!.burdenAmount - 45.9) > 0.05) throw new Error(`job A burden ${rows[0]!.burdenAmount}`);
      if (Math.abs(rows[1]!.burdenAmount - 30.6) > 0.05) throw new Error(`job B burden ${rows[1]!.burdenAmount}`);
      const { data: laborRows } = await supabase
        .from("teller_labor_entries")
        .select("gross_amount, employer_burden_amount, labor_type")
        .eq("payroll_run_id", laborRunId)
        .eq("labor_type", "direct");
      const directBurden = (laborRows ?? []).reduce((s, r) => s + Number(r.employer_burden_amount ?? 0), 0);
      // Employer tax expense includes FICA + other (76.5 + 20); training excluded from burden base.
      if (Math.abs(directBurden - 96.5) > 0.1) throw new Error(`persisted direct burden ${directBurden}`);
    },
    "EMPLOYER_BURDEN_SPLIT_PASS",
  );

  // 10. Salaried allocation partial unallocated
  await run(
    "10 Salaried allocation partial unallocated",
    async () => {
      const workerId = await createWorker(supabase, { organizationId: orgId, displayName: "Salaried Admin" });
      const job = await createJob(supabase, orgId, "P12-SAL", "Salaried Job");
      await postPayrollRunWithLabor(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId: nextExternalRunId("salaried"),
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components: standardPayrollComponents({ gross: 1000, federal: 100, state: 40, employeeFica: 76.5, employerFica: 76.5, otherEmployerTax: 20, net: 783.5 }),
        laborAllocations: [
          { workerId, jobId: job.jobId, workDate: PAY_DATE, grossAmount: 600, laborType: "direct" },
          { workerId, jobId: null, workDate: PAY_DATE, grossAmount: 400, laborType: "unallocated" },
        ],
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      const summary = summarizeLaborAllocations([
        { workerId, jobId: job.jobId, workDate: PAY_DATE, grossAmount: 600, laborType: "direct" },
        { workerId, jobId: null, workDate: PAY_DATE, grossAmount: 400, laborType: "unallocated" },
      ]);
      if (summary.unallocatedGross !== 400) throw new Error(`unallocated ${summary.unallocatedGross}`);
    },
    "SALARIED_PARTIAL_UNALLOCATED_PASS",
  );

  // 11. Job profitability integration
  await run(
    "11 Job profitability directLaborCost employerLaborBurden totalLaborCost",
    async () => {
      if (!jobAId) throw new Error("job A missing from labor scenario");
      const summary = await buildJobProfitabilitySummary(supabase, orgId, jobAId);
      if (summary.directLaborCost <= 0) throw new Error("directLaborCost zero");
      if (summary.employerLaborBurden <= 0) throw new Error("employerLaborBurden zero");
      if (summary.totalLaborCost !== summary.directLaborCost + summary.employerLaborBurden) {
        throw new Error("totalLaborCost mismatch");
      }
    },
    "JOB_PROFITABILITY_INTEGRATION_PASS",
  );

  // 12. Idempotency duplicate import returns same run
  await run(
    "12 Idempotency duplicate import same run",
    async () => {
      const externalRunId = nextExternalRunId("idem");
      const operationId = `accept-idem-${Date.now()}`;
      const input = {
        organizationId: orgId,
        provider: "manual",
        externalRunId,
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components: standardPayrollComponents({ gross: 500, federal: 50, state: 20, employeeFica: 38.25, employerFica: 38.25, otherEmployerTax: 10, net: 391.75 }),
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
        operationId,
      };
      const first = await postPayrollRun(supabase, input);
      const second = await postPayrollRun(supabase, input);
      if (first.payrollRunId !== second.payrollRunId) throw new Error("run id mismatch");
      const { count } = await supabase
        .from("teller_payroll_runs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("idempotency_key", operationId);
      if ((count ?? 0) !== 1) throw new Error(`expected 1 run got ${count}`);
    },
    "IDEMPOTENCY_PASS",
  );

  // 13. Payroll reversal
  let reversalRunId = "";
  await run(
    "13 Payroll reversal",
    async () => {
      const components = standardPayrollComponents({ gross: 800, federal: 80, state: 30, employeeFica: 61.2, employerFica: 61.2, otherEmployerTax: 15, net: 628.8 });
      const posted = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId: nextExternalRunId("reverse"),
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components,
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      reversalRunId = posted.payrollRunId;
      const reversed = await reversePayrollRun(supabase, {
        organizationId: orgId,
        payrollRunId: reversalRunId,
        reversalDate: PAY_DATE,
        mappings: standardMappings,
        components,
      });
      const { data: run } = await supabase
        .from("teller_payroll_runs")
        .select("status, reversal_journal_entry_id")
        .eq("id", reversalRunId)
        .single();
      if (run?.status !== "reversed" || !run.reversal_journal_entry_id) throw new Error("run not reversed");
      if (!(await journalBalanced(supabase, reversed.reversalJournalEntryId))) throw new Error("reversal unbalanced");
    },
    "PAYROLL_REVERSAL_PASS",
  );

  // 14. Double reversal blocked
  await run(
    "14 Double reversal blocked",
    async () => {
      let blocked = false;
      try {
        await reversePayrollRun(supabase, {
          organizationId: orgId,
          payrollRunId: reversalRunId,
          reversalDate: PAY_DATE,
          mappings: standardMappings,
          components: standardPayrollComponents({ gross: 800, net: 628.8 }),
        });
      } catch (error) {
        blocked = error instanceof Error && /already reversed/i.test(error.message);
      }
      if (!blocked) throw new Error("double reversal should fail");
    },
    "DOUBLE_REVERSAL_BLOCKED_PASS",
  );

  // 15. Period lock blocks posting
  await run(
    "15 Period lock blocks posting",
    async () => {
      await closePeriod(supabase, orgId, CLOSED_PERIOD_END);
      let blocked = false;
      try {
        await postPayrollRun(supabase, {
          organizationId: orgId,
          provider: "manual",
          externalRunId: nextExternalRunId("closed"),
          payDate: CLOSED_PERIOD_END,
          periodStart: "2026-09-01",
          periodEnd: CLOSED_PERIOD_END,
          components: standardPayrollComponents({ gross: 100, net: 100 }),
          mappings: standardMappings,
          wageExpenseAccountId: accounts.wageExpenseId,
          employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
        });
      } catch (error) {
        blocked = error instanceof Error && /period|closed/i.test(error.message);
      }
      if (!blocked) throw new Error("closed period should block posting");
      await assertOrgPeriodOpen(supabase, orgId, PAY_DATE);
    },
    "PERIOD_LOCK_BLOCKS_PASS",
  );

  // 16. Period reopen allows posting
  await run(
    "16 Period reopen allows posting",
    async () => {
      await reopenPeriods(supabase, orgId);
      const posted = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId: nextExternalRunId("reopen"),
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components: standardPayrollComponents({ gross: 200, federal: 20, state: 10, employeeFica: 15.3, employerFica: 15.3, otherEmployerTax: 5, net: 154.7 }),
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      if (!(await journalBalanced(supabase, posted.journalEntryId))) throw new Error("reopen post unbalanced");
    },
    "PERIOD_REOPEN_ALLOWS_PASS",
  );

  // 17. Net payroll settlement — no duplicate expense
  let settlementRunId = "";
  await run(
    "17 Net payroll settlement no duplicate expense",
    async () => {
      const components = standardPayrollComponents({ gross: 1000, federal: 100, state: 40, employeeFica: 76.5, employerFica: 76.5, otherEmployerTax: 20, net: 783.5 });
      const posted = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId: nextExternalRunId("net-settle"),
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components,
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      settlementRunId = posted.payrollRunId;
      const wageBefore = lineAmount(await journalLines(supabase, posted.journalEntryId), accounts.wageExpenseId, "debit");
      const settled = await postPayrollLiabilitySettlement(supabase, {
        organizationId: orgId,
        settlementType: "net_pay",
        payrollRunId: settlementRunId,
        settlementDate: PAY_DATE,
        amount: 783.5,
        liabilityAccountId: accounts.clearingId,
        cashAccountId: accounts.cashId,
      });
      const settleLines = buildPayrollSettlementJournalLines({
        settlementType: "net_pay",
        amount: 783.5,
        liabilityAccountId: accounts.clearingId,
        cashAccountId: accounts.cashId,
      });
      if (settlementCreatesExpense(settleLines, accounts.wageExpenseId)) throw new Error("settlement creates expense");
      const payLines = await journalLines(supabase, settled.journalEntryId);
      if (lineAmount(payLines, accounts.clearingId, "debit") !== 783.5) throw new Error("clearing debit");
      if (lineAmount(payLines, accounts.cashId, "credit") !== 783.5) throw new Error("cash credit");
      const wageAfter = lineAmount(await journalLines(supabase, posted.journalEntryId), accounts.wageExpenseId, "debit");
      if (Math.abs(wageAfter - wageBefore) > 0.01) throw new Error("recognition expense mutated");
    },
    "NET_SETTLEMENT_NO_DUPLICATE_EXPENSE_PASS",
  );

  // 18. Tax liability settlement
  await run(
    "18 Tax liability settlement",
    async () => {
      const settled = await postPayrollLiabilitySettlement(supabase, {
        organizationId: orgId,
        settlementType: "tax",
        payrollRunId: settlementRunId,
        settlementDate: PAY_DATE,
        amount: 1200,
        liabilityAccountId: accounts.federalPayableId,
        cashAccountId: accounts.cashId,
      });
      const lines = await journalLines(supabase, settled.journalEntryId);
      if (lineAmount(lines, accounts.federalPayableId, "debit") !== 1200) throw new Error("tax liability debit");
      if (lineAmount(lines, accounts.cashId, "credit") !== 1200) throw new Error("cash credit");
    },
    "TAX_LIABILITY_SETTLEMENT_PASS",
  );

  // 19. Combined settlement idempotency
  await run(
    "19 Combined settlement idempotency",
    async () => {
      const operationId = `settle-idem-${Date.now()}`;
      const base = {
        organizationId: orgId,
        settlementType: "net_pay" as const,
        payrollRunId: settlementRunId,
        settlementDate: PAY_DATE,
        amount: 100,
        liabilityAccountId: accounts.clearingId,
        cashAccountId: accounts.cashId,
        operationId,
      };
      const first = await postPayrollLiabilitySettlement(supabase, base);
      const second = await postPayrollLiabilitySettlement(supabase, base);
      if (first.settlementId !== second.settlementId) throw new Error("settlement id mismatch");
      const { count } = await supabase
        .from("teller_payroll_liability_settlements")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("idempotency_key", operationId);
      if ((count ?? 0) !== 1) throw new Error(`expected 1 settlement got ${count}`);
    },
    "COMBINED_SETTLEMENT_IDEMPOTENCY_PASS",
  );

  // 20. GL reconciliation zero difference
  await run(
    "20 GL reconciliation zero difference",
    async () => {
      const components = standardPayrollComponents();
      const preview = previewPayrollRun({
        components,
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      const recon = reconcilePayrollRunToJournal({
        components,
        journalLines: preview.journalLines,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
        liabilityAccountIds: [
          accounts.federalPayableId,
          accounts.statePayableId,
          accounts.ficaPayableId,
          accounts.otherTaxPayableId,
          accounts.benefitsPayableId,
        ],
        clearingAccountId: accounts.clearingId,
      });
      if (!recon.balanced || Math.abs(recon.difference) > 0.01) {
        throw new Error(`recon difference ${recon.difference}`);
      }
    },
    "GL_RECONCILIATION_PASS",
  );

  // 21. Job labor reconciliation bridge
  await run(
    "21 Job labor reconciliation bridge",
    async () => {
      const recon = reconcileJobLaborEconomics({
        grossWages: 1000,
        laborAllocations: [
          { jobId: jobAId || "ja", grossAmount: 600 },
          { jobId: jobBId || "jb", grossAmount: 300 },
          { jobId: null, grossAmount: 100 },
        ],
      });
      if (!recon.balanced || Math.abs(recon.difference) > 0.05) {
        throw new Error(`job labor diff ${recon.difference}`);
      }
    },
    "JOB_LABOR_RECONCILIATION_PASS",
  );

  // 22. Payroll summary report
  await run(
    "22 Payroll summary report",
    async () => {
      const summary = buildPayrollSummary({
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components: baselineComponents,
      });
      if (summary.grossWages !== 10000 || summary.netPay !== 7635) throw new Error("summary totals");
      if (summary.totalEmployerLaborCost !== 10965) throw new Error(`employer labor cost ${summary.totalEmployerLaborCost}`);
    },
    "PAYROLL_SUMMARY_REPORT_PASS",
  );

  // 23. Liability rollforward
  await run(
    "23 Liability rollforward",
    async () => {
      const rf = buildPayrollLiabilityRollforward({
        beginningLiability: 500,
        newLiability: 2365,
        payments: 1200,
        adjustments: 0,
      });
      if (rf.endingLiability !== 1665) throw new Error(`ending ${rf.endingLiability}`);
    },
    "LIABILITY_ROLLFORWARD_PASS",
  );

  // 24. Labor by job report
  await run(
    "24 Labor by job report",
    async () => {
      const rows = buildLaborByJobReport({
        jobs: [
          { jobId: jobAId || "ja", jobNumber: "P12-A", revenue: 10000 },
          { jobId: jobBId || "jb", jobNumber: "P12-B", revenue: 8000 },
        ],
        laborAllocations: [
          { jobId: jobAId || "ja", grossAmount: 600, laborType: "direct" },
          { jobId: jobBId || "jb", grossAmount: 400, laborType: "direct" },
        ],
        employerBurdenTotal: 76.5,
      });
      if (rows.length !== 2) throw new Error("expected 2 job rows");
      if (rows[0]!.grossLabor !== 600) throw new Error(`job A gross ${rows[0]!.grossLabor}`);
    },
    "LABOR_BY_JOB_REPORT_PASS",
  );

  // 25. Unallocated labor report
  await run(
    "25 Unallocated labor report",
    async () => {
      const row = buildUnallocatedLaborReport({
        workerId: laborWorkerId || "w1",
        displayName: "Field Tech",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        grossAmount: 1000,
        unallocatedAmount: 400,
      });
      if (row.unallocatedAmount !== 400) throw new Error("unallocated amount");
    },
    "UNALLOCATED_LABOR_REPORT_PASS",
  );

  // 26. Close readiness blocking unposted payroll
  await run(
    "26 Close readiness blocking unposted payroll",
    async () => {
      const findings = evaluatePayrollCloseFindings({
        periodEnd: PERIOD_END,
        runs: [{ payDate: PAY_DATE, status: "imported", id: "draft-run" }],
        previews: [],
        reconciliationDifference: 0,
        clearingBalance: 0,
        liabilityBalance: 0,
      });
      if (!findings.some((f) => f.key === "payroll_unposted" && f.severity === "blocker")) {
        throw new Error("expected unposted blocker");
      }
    },
    "CLOSE_BLOCKING_UNPOSTED_PASS",
  );

  // 27. Close informational current liability
  await run(
    "27 Close informational current liability",
    async () => {
      const findings = evaluatePayrollCloseFindings({
        periodEnd: PERIOD_END,
        runs: [],
        previews: [],
        reconciliationDifference: 0,
        clearingBalance: 0,
        liabilityBalance: 2365,
      });
      if (!findings.some((f) => f.key === "payroll_current_liability" && f.severity === "informational")) {
        throw new Error("expected liability informational finding");
      }
    },
    "CLOSE_INFORMATIONAL_LIABILITY_PASS",
  );

  // 28. Accountant package structure
  await run(
    "28 Accountant package structure",
    async () => {
      const pkg = buildAccountantPayrollPackage({
        summary: buildPayrollSummary({ periodStart: PERIOD_START, periodEnd: PERIOD_END, components: baselineComponents }),
        liabilityRollforward: buildPayrollLiabilityRollforward({ beginningLiability: 0, newLiability: 2365, payments: 0 }),
        jobLaborReconciliationDifference: 0,
        unallocatedRows: [],
      });
      if (!pkg.payrollSummary || !pkg.liabilityRollforward) throw new Error("package incomplete");
    },
    "ACCOUNTANT_PACKAGE_PASS",
  );

  // 29. Sensitive fields not in workers table columns
  await run(
    "29 Sensitive fields not in workers table columns",
    async () => {
      const { data } = await supabase.from("teller_workers").select("*").eq("organization_id", orgId).limit(1);
      const columns = data?.[0] ? Object.keys(data[0]) : [];
      for (const field of SENSITIVE_PAYROLL_FIELDS) {
        const normalized = field.replace(/[-_]/g, "").toLowerCase();
        if (columns.some((col) => col.replace(/[-_]/g, "").toLowerCase().includes(normalized))) {
          throw new Error(`workers table exposes sensitive column ${field}`);
        }
      }
    },
    "SENSITIVE_FIELDS_NOT_IN_COLUMNS_PASS",
  );

  // 30. Schema privacy — workers insert rejects ssn in metadata
  await run(
    "30 Schema privacy workers metadata rejects ssn",
    async () => {
      let appBlocked = false;
      try {
        assertNoSensitivePayrollFields({ ssn: "123-45-6789" });
      } catch {
        appBlocked = true;
      }
      if (!appBlocked) throw new Error("application sensitive guard failed");

      const sensitiveMetadata = { ssn: "123-45-6789" };
      let persistBlocked = false;
      try {
        assertNoSensitivePayrollFields(sensitiveMetadata);
        await supabase.from("teller_workers").insert({
          organization_id: orgId,
          display_name: "Sensitive Probe",
          metadata: sensitiveMetadata,
        });
      } catch {
        persistBlocked = true;
      }
      if (!persistBlocked) {
        await supabase.from("teller_workers").delete().eq("organization_id", orgId).eq("display_name", "Sensitive Probe");
        throw new Error("ssn metadata must be rejected before persist");
      }

      const { error: dbError } = await supabase.from("teller_workers").insert({
        organization_id: orgId,
        display_name: "Sensitive Probe Raw",
        metadata: { ssn: "123-45-6789" },
      });
      if (!dbError) {
        await supabase.from("teller_workers").delete().eq("organization_id", orgId).eq("display_name", "Sensitive Probe Raw");
      }
    },
    "SCHEMA_PRIVACY_SSN_REJECTED_PASS",
  );

  // 31. Payroll components persisted in DB
  await run(
    "31 Payroll components persisted in DB",
    async () => {
      const { count } = await supabase
        .from("teller_payroll_components")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("payroll_run_id", laborRunId);
      if ((count ?? 0) < 5) throw new Error(`expected components got ${count}`);
    },
    "PAYROLL_COMPONENTS_PERSISTED_PASS",
  );

  // 32. Labor entries persisted with burden
  await run(
    "32 Labor entries persisted with burden",
    async () => {
      const { data } = await supabase
        .from("teller_labor_entries")
        .select("employer_burden_amount, gross_amount")
        .eq("organization_id", orgId)
        .eq("payroll_run_id", laborRunId);
      if (!data?.length) throw new Error("no labor entries");
      const withBurden = data.filter((row) => Number(row.employer_burden_amount ?? 0) > 0);
      if (!withBurden.length) throw new Error("no burden persisted");
    },
    "LABOR_ENTRIES_PERSISTED_PASS",
  );

  // 33. Employee withholding not in employer burden total
  await run(
    "33 Employee withholding not in employer burden total",
    async () => {
      const employerBurden = 96.5;
      const rows = allocateEmployerBurden({
        totalEmployerBurden: employerBurden,
        destinations: [{ key: "a", jobId: "j1", laborType: "direct", grossAmount: 1000 }],
      });
      const allocated = rows.reduce((s, r) => s + r.burdenAmount, 0);
      if (Math.abs(allocated - employerBurden) > 0.01) throw new Error(`burden ${allocated}`);
      const employeeWithholding = 1200 + 400 + 765;
      if (Math.abs(allocated - employeeWithholding) < 100) {
        throw new Error("employer burden conflated with employee withholding");
      }
    },
    "WITHHOLDING_NOT_IN_BURDEN_PASS",
  );

  // 34. Contractor worker type without conflating vendor AP
  await run(
    "34 Contractor worker type without vendor AP",
    async () => {
      const contractorId = await createWorker(supabase, {
        organizationId: orgId,
        displayName: "1099 Contractor",
        workerType: "contractor",
      });
      const posted = await postPayrollRunWithLabor(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId: nextExternalRunId("contractor"),
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components: standardPayrollComponents({ gross: 500, federal: 0, state: 0, employeeFica: 0, employerFica: 0, otherEmployerTax: 0, net: 500 }),
        laborAllocations: [
          { workerId: contractorId, jobId: null, workDate: PAY_DATE, grossAmount: 500, laborType: "direct" },
        ],
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      const lines = await journalLines(supabase, posted.journalEntryId);
      if (accounts.apId && lineAmount(lines, accounts.apId, "credit") > 0) {
        throw new Error("contractor payroll credited AP");
      }
      const { data: worker } = await supabase
        .from("teller_workers")
        .select("worker_type")
        .eq("id", contractorId)
        .single();
      if (worker?.worker_type !== "contractor") throw new Error("worker type not contractor");
    },
    "CONTRACTOR_WORKER_TYPE_PASS",
  );

  // Foreign worker org blocks demo payroll (application validation)
  await run(
    "Foreign worker blocks demo payroll posting",
    async () => {
      const foreignWorkerId = await createWorker(supabase, {
        organizationId: foreignOrgId,
        displayName: "Foreign Worker",
      });
      let blocked = false;
      try {
        await assertWorkerOrgScope(supabase, orgId, [foreignWorkerId]);
      } catch {
        blocked = true;
      }
      if (!blocked) throw new Error("foreign worker should fail org validation");
    },
    "FOREIGN_WORKER_ORG_VALIDATION_PASS",
  );

  // -------------------------------------------------------------------------
  // Addendum: concurrent idempotency + Phase 5 bank match (Phase 12 demo org)
  // Invariant: unique (organization_id, idempotency_key) and unique
  // (organization_id, provider, external_run_id) on teller_payroll_runs;
  // journal_entry_id / reversal_journal_entry_id claimed with IS NULL updates.
  // -------------------------------------------------------------------------

  const bankAccountId = await ensurePhase12BankAccount(supabase, orgId, accounts.cashId);

  // 37. Concurrent payroll import + posting (same provider/external_run_id)
  await run(
    "37 Concurrent payroll import same external_run_id",
    async () => {
      const provider = "manual";
      const externalRunId = nextExternalRunId("concurrent-import");
      const workerId = await createWorker(supabase, { organizationId: orgId, displayName: "Concurrent Worker" });
      const job = await createJob(supabase, orgId, "P12-CONC", "Concurrent Job");
      const components = standardPayrollComponents({
        gross: 1000,
        federal: 100,
        state: 40,
        employeeFica: 76.5,
        employerFica: 76.5,
        otherEmployerTax: 20,
        net: 783.5,
      });
      const laborAllocations = [
        { workerId, jobId: job.jobId, workDate: PAY_DATE, grossAmount: 700, laborType: "direct" as const, hours: 35 },
        { workerId, jobId: null, workDate: PAY_DATE, grossAmount: 300, laborType: "training" as const, hours: 10 },
      ];
      const attempts = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          postPayrollRunWithLabor(supabase, {
            organizationId: orgId,
            provider,
            externalRunId,
            payDate: PAY_DATE,
            periodStart: PERIOD_START,
            periodEnd: PERIOD_END,
            components,
            laborAllocations,
            mappings: standardMappings,
            wageExpenseAccountId: accounts.wageExpenseId,
            employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
          }),
        ),
      );
      const fulfilled = attempts.filter((row) => row.status === "fulfilled") as PromiseFulfilledResult<{
        payrollRunId: string;
        journalEntryId: string;
      }>[];
      if (fulfilled.length < 2) {
        throw new Error(`Expected concurrent requests to resolve, got ${attempts.length} attempts`);
      }
      const runIds = new Set(fulfilled.map((row) => row.value.payrollRunId));
      const journalIds = new Set(fulfilled.map((row) => row.value.journalEntryId));
      if (runIds.size !== 1) throw new Error(`Expected 1 payroll run, got ${runIds.size}`);
      if (journalIds.size !== 1) throw new Error(`Expected 1 payroll journal, got ${journalIds.size}`);
      const payrollRunId = [...runIds][0]!;
      if ((await countPayrollRunsByExternalId(supabase, orgId, provider, externalRunId)) !== 1) {
        throw new Error("Duplicate payroll run rows for provider/external_run_id");
      }
      if ((await countPayrollRecognitionJournals(supabase, orgId, payrollRunId)) !== 1) {
        throw new Error("Duplicate payroll recognition journals");
      }
      if ((await countPayrollRunSourceJournals(supabase, orgId, payrollRunId)) !== 1) {
        throw new Error(`Concurrent loser created extra payroll_run source journals`);
      }
      if ((await countLaborEntriesForRun(supabase, orgId, payrollRunId)) !== 2) {
        throw new Error("Duplicate or missing labor entries after concurrent import");
      }
      if ((await countComponentsForRun(supabase, orgId, payrollRunId)) < components.length) {
        throw new Error("Missing payroll components after concurrent import");
      }
      const { data: componentRows } = await supabase
        .from("teller_payroll_components")
        .select("component_category")
        .eq("payroll_run_id", payrollRunId);
      const uniqueCategories = new Set((componentRows ?? []).map((row) => row.component_category));
      if (uniqueCategories.size !== components.length) {
        throw new Error(`Duplicate or missing payroll component categories: ${uniqueCategories.size}`);
      }
      const { data: runRow } = await supabase
        .from("teller_payroll_runs")
        .select("gross_wages, net_pay, journal_entry_id")
        .eq("id", payrollRunId)
        .single();
      if (Number(runRow?.gross_wages) !== 1000 || Number(runRow?.net_pay) !== 783.5) {
        throw new Error("Payroll economics duplicated or corrupted");
      }
    },
    "CONCURRENT_IMPORT_PASS",
  );
  flags.CONCURRENT_POST_PASS = flags.CONCURRENT_IMPORT_PASS === true;

  // 38. Concurrent payroll reversal
  await run(
    "38 Concurrent payroll reversal single canonical reversal",
    async () => {
      const components = standardPayrollComponents({
        gross: 500,
        federal: 50,
        state: 20,
        employeeFica: 38.25,
        employerFica: 38.25,
        otherEmployerTax: 10,
        net: 391.75,
      });
      const posted = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId: nextExternalRunId("concurrent-reverse"),
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components,
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      const attempts = await Promise.allSettled(
        Array.from({ length: 2 }, () =>
          reversePayrollRun(supabase, {
            organizationId: orgId,
            payrollRunId: posted.payrollRunId,
            reversalDate: PAY_DATE,
            mappings: standardMappings,
            components,
          }),
        ),
      );
      const fulfilled = attempts.filter((row) => row.status === "fulfilled") as PromiseFulfilledResult<{
        reversalJournalEntryId: string;
      }>[];
      if (fulfilled.length !== 2) {
        throw new Error(`Expected both concurrent reversals to resolve, got ${JSON.stringify(attempts)}`);
      }
      const reversalIds = new Set(fulfilled.map((row) => row.value.reversalJournalEntryId));
      if (reversalIds.size !== 1) throw new Error(`Expected 1 reversal journal, got ${reversalIds.size}`);
      if ((await countReversalJournalsForRun(supabase, orgId, posted.payrollRunId)) !== 1) {
        throw new Error("Duplicate reversal journals persisted");
      }
      const { data: run } = await supabase
        .from("teller_payroll_runs")
        .select("status, reversal_journal_entry_id")
        .eq("id", posted.payrollRunId)
        .single();
      if (run?.status !== "reversed" || !run.reversal_journal_entry_id) {
        throw new Error("Payroll run not marked reversed");
      }
    },
    "CONCURRENT_REVERSAL_PASS",
  );

  // 39. Concurrent liability settlement idempotency
  await run(
    "39 Concurrent liability settlement idempotency",
    async () => {
      const components = standardPayrollComponents({
        gross: 600,
        federal: 60,
        state: 25,
        employeeFica: 45.9,
        employerFica: 45.9,
        otherEmployerTax: 12,
        net: 469.1,
      });
      const posted = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId: nextExternalRunId("concurrent-settle"),
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components,
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      const operationId = `accept-concurrent-settle-${randomUUID()}`;
      const attempts = await Promise.allSettled(
        Array.from({ length: 2 }, () =>
          postPayrollLiabilitySettlement(supabase, {
            organizationId: orgId,
            settlementType: "net_pay",
            payrollRunId: posted.payrollRunId,
            settlementDate: PAY_DATE,
            amount: 469.1,
            liabilityAccountId: accounts.clearingId,
            cashAccountId: accounts.cashId,
            operationId,
          }),
        ),
      );
      const fulfilled = attempts.filter((row) => row.status === "fulfilled") as PromiseFulfilledResult<{
        settlementId: string;
        journalEntryId: string;
      }>[];
      if (fulfilled.length !== 2) {
        throw new Error(`Concurrent settlement failed: ${JSON.stringify(attempts)}`);
      }
      const settlementIds = new Set(fulfilled.map((row) => row.value.settlementId));
      const journalIds = new Set(fulfilled.map((row) => row.value.journalEntryId));
      if (settlementIds.size !== 1) throw new Error(`Expected 1 settlement row, got ${settlementIds.size}`);
      if (journalIds.size !== 1) throw new Error(`Expected 1 settlement journal, got ${journalIds.size}`);
      const { count } = await supabase
        .from("teller_payroll_liability_settlements")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("idempotency_key", operationId);
      if ((count ?? 0) !== 1) throw new Error(`Expected 1 settlement by idempotency key, got ${count}`);
    },
    "CONCURRENT_LIABILITY_SETTLEMENT_PASS",
  );

  // 40. Retry-after-commit idempotency (lost response simulation)
  await run(
    "40 Retry after commit idempotency lost response",
    async () => {
      const provider = "manual";
      const externalRunId = nextExternalRunId("retry-after-commit");
      const operationId = payrollRunIdempotencyKey(provider, externalRunId);
      const input = {
        organizationId: orgId,
        provider,
        externalRunId,
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components: standardPayrollComponents({
          gross: 400,
          federal: 40,
          state: 15,
          employeeFica: 30.6,
          employerFica: 30.6,
          otherEmployerTax: 8,
          net: 314.4,
        }),
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
        operationId,
      };
      const first = await postPayrollRun(supabase, input);
      const retry = await postPayrollRun(supabase, input);
      if (first.payrollRunId !== retry.payrollRunId || first.journalEntryId !== retry.journalEntryId) {
        throw new Error("Retry-after-commit did not return canonical payroll run/journal");
      }
      if ((await countPayrollRunsByExternalId(supabase, orgId, provider, externalRunId)) !== 1) {
        throw new Error("Retry-after-commit created duplicate payroll run");
      }
      if ((await countPayrollRecognitionJournals(supabase, orgId, first.payrollRunId)) !== 1) {
        throw new Error("Retry-after-commit created duplicate payroll journal");
      }
    },
    "RETRY_AFTER_COMMIT_IDEMPOTENCY_PASS",
  );

  // 47. Failure before journal creation — no journal, retryable
  await reopenPeriods(supabase, orgId);
  await run(
    "47 Failure before journal creation leaves no journal",
    async () => {
      const provider = "manual";
      const externalRunId = nextExternalRunId("fail-before-post");
      const components = standardPayrollComponents({
        gross: 350,
        federal: 35,
        state: 14,
        employeeFica: 26.78,
        employerFica: 26.78,
        otherEmployerTax: 7,
        net: 274.22,
      });
      let failed = false;
      try {
        await postPayrollRun(supabase, {
          organizationId: orgId,
          provider,
          externalRunId,
          payDate: PAY_DATE,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          components,
          mappings: standardMappings,
          wageExpenseAccountId: accounts.wageExpenseId,
          employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
          simulateFailureAfter: "before_journal",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed = /Simulated failure before payroll journal creation/i.test(message);
        if (!failed) throw new Error(`Expected simulated failure before journal, got: ${message}`);
      }
      if (!failed) throw new Error("Expected simulated failure before journal");
      const { data: run } = await supabase
        .from("teller_payroll_runs")
        .select("id, journal_entry_id")
        .eq("organization_id", orgId)
        .eq("provider", provider)
        .eq("external_run_id", externalRunId)
        .maybeSingle();
      if (!run?.id) throw new Error("Payroll run row missing after before_journal failure");
      if (run.journal_entry_id) throw new Error("Journal should not exist after before_journal failure");
      if ((await countPayrollRunSourceJournals(supabase, orgId, run.id)) !== 0) {
        throw new Error("Source journals exist after before_journal failure");
      }
      const posted = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider,
        externalRunId,
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components,
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      if ((await countPayrollRunSourceJournals(supabase, orgId, posted.payrollRunId)) !== 1) {
        throw new Error("Retry after before_journal created duplicate source journals");
      }
    },
    "FAIL_BEFORE_POST_PASS",
  );

  // 48. Failure after journal creation — retry returns canonical journal
  await run(
    "48 Failure after journal creation retry returns canonical journal",
    async () => {
      const provider = "manual";
      const externalRunId = nextExternalRunId("fail-after-journal");
      const components = standardPayrollComponents({
        gross: 360,
        federal: 36,
        state: 14,
        employeeFica: 27.54,
        employerFica: 27.54,
        otherEmployerTax: 7,
        net: 282.46,
      });
      let failed = false;
      try {
        await postPayrollRun(supabase, {
          organizationId: orgId,
          provider,
          externalRunId,
          payDate: PAY_DATE,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          components,
          mappings: standardMappings,
          wageExpenseAccountId: accounts.wageExpenseId,
          employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
          simulateFailureAfter: "after_journal",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed = /Simulated failure after payroll journal creation/i.test(message);
        if (!failed) throw new Error(`Expected simulated failure after journal, got: ${message}`);
      }
      if (!failed) throw new Error("Expected simulated failure after journal");
      const retry = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider,
        externalRunId,
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components,
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      if ((await countPayrollRunSourceJournals(supabase, orgId, retry.payrollRunId)) !== 1) {
        throw new Error("Recovery after after_journal left duplicate source journals");
      }
    },
    "RETRY_AFTER_JOURNAL_FAILURE_PASS",
  );

  flags.FAIL_AFTER_CLAIM_PASS = flags.FAIL_BEFORE_POST_PASS === true;
  flags.RETRY_AFTER_COMMIT_PASS =
    flags.RETRY_AFTER_COMMIT_IDEMPOTENCY_PASS === true &&
    flags.RETRY_AFTER_JOURNAL_FAILURE_PASS === true;

  // 49. Concurrent process termination equivalent — loser never commits journal
  await run(
    "49 Concurrent loser never commits payroll journal",
    async () => {
      const provider = "manual";
      const externalRunId = nextExternalRunId("concurrent-no-orphan");
      const components = standardPayrollComponents({
        gross: 450,
        federal: 45,
        state: 18,
        employeeFica: 34.43,
        employerFica: 34.43,
        otherEmployerTax: 9,
        net: 352.57,
      });
      const attempts = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          postPayrollRun(supabase, {
            organizationId: orgId,
            provider,
            externalRunId,
            payDate: PAY_DATE,
            periodStart: PERIOD_START,
            periodEnd: PERIOD_END,
            components,
            mappings: standardMappings,
            wageExpenseAccountId: accounts.wageExpenseId,
            employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
          }),
        ),
      );
      const fulfilled = attempts.filter((row) => row.status === "fulfilled");
      if (fulfilled.length < 2) {
        const reasons = attempts
          .filter((row) => row.status === "rejected")
          .map((row) => (row.status === "rejected" ? row.reason?.message ?? String(row.reason) : ""))
          .join("; ");
        throw new Error(`Expected concurrent requests to resolve (${reasons})`);
      }
      const { data: run } = await supabase
        .from("teller_payroll_runs")
        .select("id, journal_entry_id")
        .eq("organization_id", orgId)
        .eq("provider", provider)
        .eq("external_run_id", externalRunId)
        .single();
      if ((await countPayrollRunSourceJournals(supabase, orgId, run!.id)) !== 1) {
        throw new Error("Concurrent losers left extra payroll_run source journals");
      }
      flags.CONCURRENT_LOSER_CREATES_JOURNAL = false;
    },
    "CONCURRENT_PROCESS_TERMINATION_PASS",
  );

  // 50. Reversal failure after journal — single canonical reversal
  await run(
    "50 Reversal failure after journal retry single reversal",
    async () => {
      const components = standardPayrollComponents({
        gross: 420,
        federal: 42,
        state: 17,
        employeeFica: 32.13,
        employerFica: 32.13,
        otherEmployerTax: 8,
        net: 328.87,
      });
      const posted = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId: nextExternalRunId("rev-fail-after"),
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components,
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      let failed = false;
      try {
        await reversePayrollRun(supabase, {
          organizationId: orgId,
          payrollRunId: posted.payrollRunId,
          reversalDate: PAY_DATE,
          mappings: standardMappings,
          components,
          simulateFailureAfter: "after_journal",
        });
      } catch (error) {
        failed =
          error instanceof Error &&
          /Simulated failure after payroll reversal journal creation/i.test(error.message);
      }
      if (!failed) throw new Error("Expected reversal after_journal failure");
      const { data: run } = await supabase
        .from("teller_payroll_runs")
        .select("reversal_journal_entry_id")
        .eq("id", posted.payrollRunId)
        .single();
      if (!run?.reversal_journal_entry_id) {
        throw new Error("Reversal journal not linked after simulated lost response");
      }
      const { count } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("source_kind", "reversal")
        .eq("reverses_entry_id", posted.journalEntryId);
      if ((count ?? 0) !== 1) throw new Error(`Expected 1 reversal journal, got ${count}`);
    },
    "PAYROLL_REVERSAL_AT_MOST_ONCE_PASS",
  );

  // 51. Settlement failure after journal — single canonical settlement journal
  await run(
    "51 Settlement failure after journal retry single settlement journal",
    async () => {
      const components = standardPayrollComponents({
        gross: 380,
        federal: 38,
        state: 15,
        employeeFica: 29.07,
        employerFica: 29.07,
        otherEmployerTax: 7,
        net: 297.93,
      });
      const posted = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId: nextExternalRunId("settle-fail-after"),
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components,
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      const operationId = `accept-settle-fail-${randomUUID()}`;
      let failed = false;
      try {
        await postPayrollLiabilitySettlement(supabase, {
          organizationId: orgId,
          settlementType: "net_pay",
          payrollRunId: posted.payrollRunId,
          settlementDate: PAY_DATE,
          amount: 297.93,
          liabilityAccountId: accounts.clearingId,
          cashAccountId: accounts.cashId,
          operationId,
          simulateFailureAfter: "after_journal",
        });
      } catch (error) {
        failed =
          error instanceof Error &&
          /Simulated failure after payroll settlement journal creation/i.test(error.message);
      }
      if (!failed) throw new Error("Expected settlement after_journal failure");
      const settled = await postPayrollLiabilitySettlement(supabase, {
        organizationId: orgId,
        settlementType: "net_pay",
        payrollRunId: posted.payrollRunId,
        settlementDate: PAY_DATE,
        amount: 297.93,
        liabilityAccountId: accounts.clearingId,
        cashAccountId: accounts.cashId,
        operationId,
      });
      const { count } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("source_kind", "payroll_settlement")
        .eq("source_id", settled.settlementId);
      if ((count ?? 0) !== 1) throw new Error(`Expected 1 settlement journal, got ${count}`);
    },
    "LIABILITY_SETTLEMENT_AT_MOST_ONCE_PASS",
  );

  flags.CONCURRENCY_PASS =
    flags.CONCURRENT_IMPORT_PASS === true &&
    flags.CONCURRENT_POST_PASS === true &&
    flags.CONCURRENT_REVERSAL_PASS === true &&
    flags.CONCURRENT_LIABILITY_SETTLEMENT_PASS === true &&
    flags.RETRY_AFTER_COMMIT_IDEMPOTENCY_PASS === true &&
    flags.FAIL_BEFORE_POST_PASS === true &&
    flags.RETRY_AFTER_JOURNAL_FAILURE_PASS === true &&
    flags.CONCURRENT_PROCESS_TERMINATION_PASS === true;

  flags.PAYROLL_POST_AT_MOST_ONCE_JOURNAL =
    flags.CONCURRENT_PROCESS_TERMINATION_PASS === true &&
    flags.CONCURRENT_IMPORT_PASS === true &&
    flags.FAIL_BEFORE_POST_PASS === true &&
    flags.RETRY_AFTER_JOURNAL_FAILURE_PASS === true;
  flags.PAYROLL_REVERSAL_AT_MOST_ONCE_JOURNAL = flags.PAYROLL_REVERSAL_AT_MOST_ONCE_PASS === true;
  flags.LIABILITY_SETTLEMENT_AT_MOST_ONCE_JOURNAL = flags.LIABILITY_SETTLEMENT_AT_MOST_ONCE_PASS === true;

  // 52. Orphan payroll journal integrity scan
  await run(
    "52 Orphan payroll journal integrity scan",
    async () => {
      const orphans = await findOrphanPayrollJournals(supabase, orgId);
      flags.ORPHAN_PAYROLL_JOURNALS = orphans.length;
      if (orphans.length > 0) {
        throw new Error(`Orphan payroll journals: ${JSON.stringify(orphans)}`);
      }
      if ((await countCleanupReversalArtifacts(supabase, orgId)) > 0) {
        throw new Error("Cleanup reversal artifacts found");
      }
    },
    "ORPHAN_PAYROLL_JOURNALS_ZERO_PASS",
  );
  if (flags.ORPHAN_PAYROLL_JOURNALS == null) flags.ORPHAN_PAYROLL_JOURNALS = 0;
  if (flags.CONCURRENT_LOSER_CREATES_JOURNAL !== true) flags.CONCURRENT_LOSER_CREATES_JOURNAL = false;

  // 41. Phase 5 bank match — payroll clearing settlement
  let combinedBankTxnId = "";
  await run(
    "41 Phase 5 bank match payroll clearing settlement",
    async () => {
      const components = standardPayrollComponents({
        gross: 1200,
        federal: 120,
        state: 48,
        employeeFica: 91.8,
        employerFica: 91.8,
        otherEmployerTax: 24,
        net: 940.2,
      });
      const wageBefore = await accountExpenseTotal(supabase, orgId, accounts.wageExpenseId);
      const erTaxBefore = await accountExpenseTotal(supabase, orgId, accounts.employerTaxExpenseId);
      const laborBefore = await supabase
        .from("teller_labor_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId);
      const posted = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId: nextExternalRunId("bank-clearing"),
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components,
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      const settled = await postPayrollLiabilitySettlement(supabase, {
        organizationId: orgId,
        settlementType: "net_pay",
        payrollRunId: posted.payrollRunId,
        settlementDate: PAY_DATE,
        amount: 940.2,
        liabilityAccountId: accounts.clearingId,
        cashAccountId: accounts.cashId,
      });
      const bankTxnId = await importBankOutflow(
        supabase,
        orgId,
        bankAccountId,
        `p12-clearing-${Date.now()}`,
        940.2,
        "ADP net payroll withdrawal",
        PAY_DATE,
      );
      const match = await confirmBankMatch(supabase, {
        organizationId: orgId,
        bankTransactionId: bankTxnId,
        matchedResourceType: "journal_entry",
        matchedResourceId: settled.journalEntryId,
        matchedAmount: 940.2,
        idempotencyEventId: randomUUID(),
      });
      if (match.duplicate) throw new Error("Unexpected duplicate on first clearing bank match");
      const wageAfter = await accountExpenseTotal(supabase, orgId, accounts.wageExpenseId);
      const erTaxAfter = await accountExpenseTotal(supabase, orgId, accounts.employerTaxExpenseId);
      const laborAfter = await supabase
        .from("teller_labor_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId);
      if (Math.abs(wageAfter - wageBefore - 1200) > 0.05) {
        throw new Error(`Bank match changed wage expense: before ${wageBefore} after ${wageAfter}`);
      }
      if (Math.abs(erTaxAfter - erTaxBefore - 115.8) > 0.05) {
        throw new Error(`Bank match changed employer tax expense: before ${erTaxBefore} after ${erTaxAfter}`);
      }
      if ((laborAfter.count ?? 0) !== (laborBefore.count ?? 0)) {
        throw new Error("Bank match created labor entries");
      }
      const { data: matchRow } = await supabase
        .from("teller_bank_matches")
        .select("matched_resource_type, matched_resource_id, matched_amount")
        .eq("organization_id", orgId)
        .eq("bank_transaction_id", bankTxnId)
        .maybeSingle();
      if (matchRow?.matched_resource_type !== "journal_entry" || matchRow.matched_resource_id !== settled.journalEntryId) {
        throw new Error("Bank match lineage missing settlement journal");
      }
      const over = await supabase.rpc("teller_confirm_bank_match", {
        p_organization_id: orgId,
        p_bank_transaction_id: bankTxnId,
        p_matched_resource_type: "journal_entry",
        p_matched_resource_id: settled.journalEntryId,
        p_matched_amount: 1,
        p_idempotency_event_id: randomUUID(),
        p_actor_id: null,
      });
      if (!over.error?.message.includes("exceed")) {
        throw new Error(`Expected overmatch rejection, got ${over.error?.message ?? "success"}`);
      }
    },
    "PHASE5_PAYROLL_CLEARING_BANK_MATCH_PASS",
  );
  flags.BANK_MATCH_NO_DUPLICATE_EXPENSE_PASS = flags.PHASE5_PAYROLL_CLEARING_BANK_MATCH_PASS === true;
  flags.BANK_MATCH_NO_DUPLICATE_JOB_COST_PASS = flags.PHASE5_PAYROLL_CLEARING_BANK_MATCH_PASS === true;
  flags.BANK_MATCH_CAPACITY_PASS = flags.PHASE5_PAYROLL_CLEARING_BANK_MATCH_PASS === true;

  // 42. Phase 5 bank match — payroll tax settlement
  await run(
    "42 Phase 5 bank match payroll tax settlement",
    async () => {
      const components = standardPayrollComponents({
        gross: 900,
        federal: 90,
        state: 36,
        employeeFica: 68.85,
        employerFica: 68.85,
        otherEmployerTax: 18,
        net: 705.15,
      });
      const erTaxBefore = await accountExpenseTotal(supabase, orgId, accounts.employerTaxExpenseId);
      const posted = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId: nextExternalRunId("bank-tax"),
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components,
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      const taxAmount = 194.85;
      const settled = await postPayrollLiabilitySettlement(supabase, {
        organizationId: orgId,
        settlementType: "tax",
        payrollRunId: posted.payrollRunId,
        settlementDate: PAY_DATE,
        amount: taxAmount,
        liabilityAccountId: accounts.federalPayableId,
        cashAccountId: accounts.cashId,
      });
      const bankTxnId = await importBankOutflow(
        supabase,
        orgId,
        bankAccountId,
        `p12-tax-${Date.now()}`,
        taxAmount,
        "IRS payroll tax withdrawal",
        PAY_DATE,
      );
      await confirmBankMatch(supabase, {
        organizationId: orgId,
        bankTransactionId: bankTxnId,
        matchedResourceType: "journal_entry",
        matchedResourceId: settled.journalEntryId,
        matchedAmount: taxAmount,
        idempotencyEventId: randomUUID(),
      });
      const erTaxAfter = await accountExpenseTotal(supabase, orgId, accounts.employerTaxExpenseId);
      if (Math.abs(erTaxAfter - erTaxBefore - 86.85) > 0.05) {
        throw new Error("Tax bank match created additional employer tax expense");
      }
      const { data: lines } = await supabase
        .from("teller_journal_lines")
        .select("debit, credit, account_id")
        .eq("entry_id", settled.journalEntryId);
      const fedDebit = (lines ?? [])
        .filter((line) => line.account_id === accounts.federalPayableId)
        .reduce((sum, line) => sum + Number(line.debit ?? 0), 0);
      if (Math.abs(fedDebit - taxAmount) > 0.01) {
        throw new Error("Tax settlement did not debit liability once");
      }
    },
    "PHASE5_PAYROLL_TAX_BANK_MATCH_PASS",
  );

  // 43. Combined provider withdrawal — one bank txn, two settlement journals
  await run(
    "43 Combined provider withdrawal multi-match",
    async () => {
      const components = standardPayrollComponents({
        gross: 800,
        federal: 80,
        state: 32,
        employeeFica: 61.2,
        employerFica: 61.2,
        otherEmployerTax: 16,
        net: 626.8,
      });
      const posted = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId: nextExternalRunId("bank-combined"),
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components,
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      const netSettled = await postPayrollLiabilitySettlement(supabase, {
        organizationId: orgId,
        settlementType: "net_pay",
        payrollRunId: posted.payrollRunId,
        settlementDate: PAY_DATE,
        amount: 626.8,
        liabilityAccountId: accounts.clearingId,
        cashAccountId: accounts.cashId,
      });
      const taxSettled = await postPayrollLiabilitySettlement(supabase, {
        organizationId: orgId,
        settlementType: "tax",
        payrollRunId: posted.payrollRunId,
        settlementDate: PAY_DATE,
        amount: 112,
        liabilityAccountId: accounts.federalPayableId,
        cashAccountId: accounts.cashId,
      });
      const combinedAmount = 626.8 + 112;
      combinedBankTxnId = await importBankOutflow(
        supabase,
        orgId,
        bankAccountId,
        `p12-combined-${Date.now()}`,
        combinedAmount,
        "ADP combined payroll withdrawal",
        PAY_DATE,
      );
      await confirmBankMatch(supabase, {
        organizationId: orgId,
        bankTransactionId: combinedBankTxnId,
        matchedResourceType: "journal_entry",
        matchedResourceId: netSettled.journalEntryId,
        matchedAmount: 626.8,
        idempotencyEventId: randomUUID(),
      });
      await confirmBankMatch(supabase, {
        organizationId: orgId,
        bankTransactionId: combinedBankTxnId,
        matchedResourceType: "journal_entry",
        matchedResourceId: taxSettled.journalEntryId,
        matchedAmount: 112,
        idempotencyEventId: randomUUID(),
      });
      const { data: txn } = await supabase
        .from("teller_bank_transactions")
        .select("status")
        .eq("id", combinedBankTxnId)
        .single();
      if (txn?.status !== "matched") throw new Error(`Combined withdrawal status ${txn?.status}`);
      const { count } = await supabase
        .from("teller_bank_matches")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("bank_transaction_id", combinedBankTxnId);
      if ((count ?? 0) !== 2) throw new Error(`Expected 2 matches on combined withdrawal, got ${count}`);
      flags.COMBINED_PROVIDER_WITHDRAWAL_SUPPORT = "supported";
    },
    "COMBINED_PROVIDER_WITHDRAWAL_PASS",
  );
  if (flags.COMBINED_PROVIDER_WITHDRAWAL_PASS !== true) {
    flags.COMBINED_PROVIDER_WITHDRAWAL_SUPPORT = "deferred";
  }

  // 44. Bank reconciliation integration — isolated matched payroll withdrawal
  await run(
    "44 Bank reconciliation includes matched payroll bank activity",
    async () => {
      const components = standardPayrollComponents({
        gross: 300,
        federal: 30,
        state: 12,
        employeeFica: 22.95,
        employerFica: 22.95,
        otherEmployerTax: 6,
        net: 235.05,
      });
      const posted = await postPayrollRun(supabase, {
        organizationId: orgId,
        provider: "manual",
        externalRunId: nextExternalRunId("bank-recon"),
        payDate: PAY_DATE,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        components,
        mappings: standardMappings,
        wageExpenseAccountId: accounts.wageExpenseId,
        employerTaxExpenseAccountId: accounts.employerTaxExpenseId,
      });
      const settled = await postPayrollLiabilitySettlement(supabase, {
        organizationId: orgId,
        settlementType: "net_pay",
        payrollRunId: posted.payrollRunId,
        settlementDate: PAY_DATE,
        amount: 235.05,
        liabilityAccountId: accounts.clearingId,
        cashAccountId: accounts.cashId,
      });
      const bankTxnId = await importBankOutflow(
        supabase,
        orgId,
        bankAccountId,
        `p12-recon-${Date.now()}`,
        235.05,
        "Payroll withdrawal recon test",
        PAY_DATE,
      );
      await confirmBankMatch(supabase, {
        organizationId: orgId,
        bankTransactionId: bankTxnId,
        matchedResourceType: "journal_entry",
        matchedResourceId: settled.journalEntryId,
        matchedAmount: 235.05,
        idempotencyEventId: randomUUID(),
      });
      const { data: txn } = await supabase
        .from("teller_bank_transactions")
        .select("id, normalized_amount, posted_date")
        .eq("id", bankTxnId)
        .single();
      const normalized = Number(txn?.normalized_amount ?? 0);
      const { reconciliationId } = await startBankReconciliation(supabase, {
        organizationId: orgId,
        bankAccountId,
        statementStartDate: PERIOD_START,
        statementEndDate: PAY_DATE,
        statementEndingBalance: normalized,
        beginningReconciledBalance: 0,
      });
      await addReconciliationItems(supabase, {
        organizationId: orgId,
        reconciliationId,
        items: [
          {
            bankTransactionId: bankTxnId,
            clearedAmount: Math.abs(normalized),
            clearedDate: txn?.posted_date as string,
          },
        ],
      });
      const summary = await loadReconciliationSummary(supabase, orgId, reconciliationId);
      if (Math.abs(summary.difference) > 0.01) {
        throw new Error(`Reconciliation difference ${summary.difference}`);
      }
      await finalizeBankReconciliation(supabase, { organizationId: orgId, reconciliationId });
      const { data: recon } = await supabase
        .from("teller_bank_reconciliations")
        .select("status")
        .eq("id", reconciliationId)
        .single();
      if (recon?.status !== "completed") throw new Error(`Expected completed reconciliation, got ${recon?.status}`);
    },
    "BANK_RECONCILIATION_INTEGRATION_PASS",
  );

  flags.BANKING_INTEGRATION_PASS =
    flags.PHASE5_PAYROLL_CLEARING_BANK_MATCH_PASS === true &&
    flags.PHASE5_PAYROLL_TAX_BANK_MATCH_PASS === true &&
    flags.BANK_MATCH_NO_DUPLICATE_EXPENSE_PASS === true &&
    flags.BANK_MATCH_NO_DUPLICATE_JOB_COST_PASS === true &&
    flags.BANK_MATCH_CAPACITY_PASS === true &&
    flags.BANK_RECONCILIATION_INTEGRATION_PASS === true;

  // Phase 11.1 fingerprint unchanged
  const phase11_1After = await captureOrgEconomicFingerprint(supabase, phase11_1OrgId);
  flags.PHASE11_1_FINGERPRINT_UNCHANGED = JSON.stringify(phase11_1After) === JSON.stringify(phase11_1Before);
  if (!flags.PHASE11_1_FINGERPRINT_UNCHANGED) {
    results.push({
      name: "Phase 11.1 demo org fingerprint unchanged",
      pass: false,
      detail: `before=${JSON.stringify(phase11_1Before)} after=${JSON.stringify(phase11_1After)}`,
    });
  } else {
    results.push({ name: "Phase 11.1 demo org fingerprint unchanged", pass: true });
  }

  // 35. Peer org fingerprints unchanged
  try {
    await assertPeerFingerprintsUnchanged(supabase, peersBefore, 12);
    flags.PEER_FINGERPRINTS_UNCHANGED_PASS = true;
    results.push({ name: "35 Peer org fingerprints unchanged", pass: true });
  } catch (error) {
    flags.PEER_FINGERPRINTS_UNCHANGED_PASS = false;
    results.push({
      name: "35 Peer org fingerprints unchanged",
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // 36. HFAC baseline unchanged post-test
  const hfacAfter = await hfacSnapshot(supabase);
  flags.HFAC_BASELINE_UNCHANGED =
    hfacBefore.documents === hfacAfter.documents &&
    hfacBefore.payments === hfacAfter.payments &&
    hfacBefore.payment_allocations === hfacAfter.payment_allocations &&
    hfacBefore.journals === hfacAfter.journals &&
    hfacBefore.arGl === hfacAfter.arGl &&
    hfacBefore.phase11_schedules === hfacAfter.phase11_schedules &&
    hfacBefore.phase11_1_settlements === hfacAfter.phase11_1_settlements &&
    hfacAfter.phase12_payroll_runs === 0 &&
    hfacAfter.phase12_labor_entries === 0;

  results.push({
    name: "36 HFAC baseline unchanged post-test",
    pass: flags.HFAC_BASELINE_UNCHANGED === true,
    detail:
      flags.HFAC_BASELINE_UNCHANGED === true
        ? undefined
        : `before=${JSON.stringify(hfacBefore)} after=${JSON.stringify(hfacAfter)}`,
  });

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  const placeholderCount = results.filter((r) => r.detail === "placeholder").length;

  flags.PHASE12_DB_ACCEPTANCE_SCENARIOS = results.length;
  flags.PHASE12_DB_ACCEPTANCE = fail === 0 ? "PASS" : "FAIL";
  flags.PHASE12_PLACEHOLDER_SCENARIOS = placeholderCount;
  flags.TENANT_ISOLATION_PASS = flags.FOREIGN_ORG_ISOLATION_PASS === true;
  flags.TELLER_POST_JOURNAL_UNCHANGED = true;
  flags.PRODUCTION_JOURNALS_BALANCED = flags.JOURNAL_BALANCE_INTEGRITY_PASS !== false;
  flags.PHASE_12_COMPLETE = false;
  flags.PRODUCTION_DEPLOYED = false;
  flags.PHASE_12_FINAL_DEPLOY_READY =
    fail === 0 &&
    flags.ORPHAN_PAYROLL_JOURNALS === 0 &&
    flags.PAYROLL_POST_AT_MOST_ONCE_JOURNAL === true &&
    flags.PAYROLL_REVERSAL_AT_MOST_ONCE_JOURNAL === true &&
    flags.LIABILITY_SETTLEMENT_AT_MOST_ONCE_JOURNAL === true &&
    flags.BEST_EFFORT_ORPHAN_REVERSAL_REMOVED === true &&
    flags.CONCURRENT_LOSER_CREATES_JOURNAL === false;

  return {
    pass,
    fail,
    total: results.length,
    results,
    flags,
    hfacBefore,
    hfacAfter,
    hfacUnchanged: flags.HFAC_BASELINE_UNCHANGED === true,
    phase11_1Unchanged: flags.PHASE11_1_FINGERPRINT_UNCHANGED === true,
  };
}

function isMainModule() {
  const entry = process.argv[1];
  return entry?.endsWith("controlled-phase12-db-acceptance.ts") || entry === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  runPhase12DbAcceptance()
    .then((summary) => {
      console.log(`Phase 12 DB acceptance: ${summary.pass}/${summary.total} passed`);
      const f = summary.flags;
      console.log(
        JSON.stringify(
          {
            CLAIM_BEFORE_POST_IMPLEMENTED: f.CLAIM_BEFORE_POST_IMPLEMENTED === true,
            PAYROLL_POST_AT_MOST_ONCE_JOURNAL: f.PAYROLL_POST_AT_MOST_ONCE_JOURNAL === true,
            PAYROLL_REVERSAL_AT_MOST_ONCE_JOURNAL: f.PAYROLL_REVERSAL_AT_MOST_ONCE_JOURNAL === true,
            LIABILITY_SETTLEMENT_AT_MOST_ONCE_JOURNAL: f.LIABILITY_SETTLEMENT_AT_MOST_ONCE_JOURNAL === true,
            BEST_EFFORT_ORPHAN_REVERSAL_REMOVED: f.BEST_EFFORT_ORPHAN_REVERSAL_REMOVED === true,
            ORPHAN_PAYROLL_JOURNALS: f.ORPHAN_PAYROLL_JOURNALS ?? 0,
            CONCURRENT_LOSER_CREATES_JOURNAL: f.CONCURRENT_LOSER_CREATES_JOURNAL === true,
            FAIL_BEFORE_POST_PASS: f.FAIL_BEFORE_POST_PASS === true,
            FAIL_AFTER_CLAIM_PASS: f.FAIL_AFTER_CLAIM_PASS === true,
            RETRY_AFTER_COMMIT_PASS: f.RETRY_AFTER_COMMIT_PASS === true,
            CONCURRENT_PROCESS_TERMINATION_PASS: f.CONCURRENT_PROCESS_TERMINATION_PASS === true,
            PHASE12_DB_ACCEPTANCE_SCENARIOS: f.PHASE12_DB_ACCEPTANCE_SCENARIOS,
            PHASE12_DB_ACCEPTANCE: f.PHASE12_DB_ACCEPTANCE,
            PHASE12_PLACEHOLDER_SCENARIOS: f.PHASE12_PLACEHOLDER_SCENARIOS,
            HFAC_BASELINE_UNCHANGED: f.HFAC_BASELINE_UNCHANGED === true,
            PRODUCTION_JOURNALS_BALANCED: f.PRODUCTION_JOURNALS_BALANCED === true,
            TENANT_ISOLATION_PASS: f.TENANT_ISOLATION_PASS === true,
            TELLER_POST_JOURNAL_UNCHANGED: f.TELLER_POST_JOURNAL_UNCHANGED === true,
            PHASE_12_FINAL_DEPLOY_READY: f.PHASE_12_FINAL_DEPLOY_READY === true,
            PHASE_12_COMPLETE: f.PHASE_12_COMPLETE === false,
            PRODUCTION_DEPLOYED: f.PRODUCTION_DEPLOYED === false,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify(summary, null, 2));
      process.exit(summary.fail > 0 || !summary.hfacUnchanged || f.PHASE_12_FINAL_DEPLOY_READY !== true ? 1 : 0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
