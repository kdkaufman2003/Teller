/**
 * Canonical job profitability calculations.
 *
 * Projected cost methodology (documented for tests):
 *   Remaining Budget = max(0, Estimated Cost - Actual Direct Cost)
 *   Projected Cost = Actual Direct Cost + max(Remaining Budget, Remaining Committed Cost)
 *   If no budget: Projected Cost = Actual Direct Cost + Remaining Committed Cost
 *
 * Projected revenue priority:
 *   1. revised_contract_amount
 *   2. estimated_revenue
 *   3. recognized revenue
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { authoritativeDocumentRemaining } from "./balances";
import { allocateDocumentRemainingByJob } from "./job-allocation";
import { roundMoney } from "./payment-fees";
import type { AccountRow } from "./reports";

export type JobRecord = {
  id: string;
  organization_id: string;
  job_number: string;
  name: string;
  status: string;
  party_id: string | null;
  original_contract_amount: number;
  revised_contract_amount: number | null;
  estimated_revenue: number;
  estimated_cost: number;
  quoted_amount: number;
};

export type JournalLineForJob = {
  account_id: string;
  debit: number;
  credit: number;
  job_id: string | null;
  cost_classification?: string | null;
};

export type GlReconciliationSlice = {
  glActivity: number;
  jobAttributed: number;
  unassigned: number;
  difference: number;
};

export type JobProfitabilitySummary = {
  jobId: string;
  originalContractAmount: number;
  revisedContractAmount: number | null;
  estimatedRevenue: number;
  recognizedRevenue: number;
  cashCollected: number;
  customerDepositsHeld: number;
  estimatedCost: number;
  committedCost: number;
  remainingCommittedCost: number;
  actualDirectCost: number;
  indirectCost: number;
  directLaborCost: number;
  employerLaborBurden: number;
  totalLaborCost: number;
  grossProfit: number;
  grossMarginPercent: number | null;
  remainingBudget: number;
  projectedRevenue: number;
  projectedCost: number;
  projectedGrossProfit: number;
  projectedGrossMarginPercent: number | null;
  accountsReceivable: number;
  accountsPayable: number;
  glReconciliation: {
    revenue: GlReconciliationSlice;
    directCost: GlReconciliationSlice;
  };
};

export function marginPercent(profit: number, revenue: number): number | null {
  if (revenue <= 0.009) return null;
  return roundMoney((profit / revenue) * 100);
}

/** Remaining budget = max(0, estimated cost - actual direct cost). */
export function computeRemainingBudget(estimatedCost: number, actualDirectCost: number): number {
  return roundMoney(Math.max(0, estimatedCost - actualDirectCost));
}

/**
 * Projected cost = actual + max(remaining budget, remaining committed).
 * When estimated cost is zero, remaining budget is zero.
 */
export function computeProjectedCost(
  actualDirectCost: number,
  remainingBudget: number,
  remainingCommittedCost: number,
): number {
  return roundMoney(actualDirectCost + Math.max(remainingBudget, remainingCommittedCost));
}

export function computeProjectedRevenue(input: {
  revisedContractAmount: number | null;
  estimatedRevenue: number;
  recognizedRevenue: number;
}): number {
  if (input.revisedContractAmount != null && input.revisedContractAmount > 0) {
    return roundMoney(input.revisedContractAmount);
  }
  if (input.estimatedRevenue > 0) return roundMoney(input.estimatedRevenue);
  return roundMoney(input.recognizedRevenue);
}

export function plAmountForAccountType(type: string, debit: number, credit: number): number {
  if (type === "revenue") return credit - debit;
  if (type === "cogs" || type === "expense") return debit - credit;
  return 0;
}

export function isEconomicRevenueLine(type: string, debit: number, credit: number): boolean {
  return type === "revenue" && credit > debit + 0.009;
}

/** Revenue recognition and credit-memo reductions (debit-side revenue). */
export function isEconomicRevenueActivity(type: string, debit: number, credit: number): boolean {
  return type === "revenue" && Math.abs(credit - debit) > 0.009;
}

export function isEconomicDirectCostLine(
  type: string,
  debit: number,
  credit: number,
  costClassification: string | null | undefined,
): boolean {
  if (costClassification === "indirect") return false;
  if (!["cogs", "expense"].includes(type)) return false;
  return debit > credit + 0.009;
}

export function isEconomicIndirectCostLine(
  type: string,
  debit: number,
  credit: number,
  costClassification: string | null | undefined,
): boolean {
  if (costClassification !== "indirect") return false;
  if (!["cogs", "expense"].includes(type)) return false;
  return debit > credit + 0.009;
}

export function summarizeLaborForJob(
  jobId: string,
  laborEntries: Array<{
    job_id: string | null;
    gross_amount: number;
    employer_burden_amount: number;
    labor_type?: string | null;
  }>,
): { directLaborCost: number; employerLaborBurden: number; totalLaborCost: number } {
  let directLaborCost = 0;
  let employerLaborBurden = 0;
  for (const row of laborEntries) {
    if (row.job_id !== jobId) continue;
    if ((row.labor_type ?? "direct") !== "direct") continue;
    directLaborCost += asNumber(row.gross_amount);
    employerLaborBurden += asNumber(row.employer_burden_amount);
  }
  directLaborCost = roundMoney(directLaborCost);
  employerLaborBurden = roundMoney(employerLaborBurden);
  return {
    directLaborCost,
    employerLaborBurden,
    totalLaborCost: roundMoney(directLaborCost + employerLaborBurden),
  };
}

export function computeActualDirectCostWithLabor(
  journalDirectCost: number,
  directLaborCost: number,
  employerLaborBurden: number,
): number {
  return roundMoney(journalDirectCost + directLaborCost + employerLaborBurden);
}

export function summarizeJournalLinesForJob(
  jobId: string,
  lines: JournalLineForJob[],
  accounts: AccountRow[],
): {
  recognizedRevenue: number;
  actualDirectCost: number;
  indirectCost: number;
} {
  const accountMap = new Map(accounts.map((row) => [row.id, row]));
  let recognizedRevenue = 0;
  let actualDirectCost = 0;
  let indirectCost = 0;

  for (const line of lines) {
    if (line.job_id !== jobId) continue;
    const account = accountMap.get(line.account_id);
    if (!account) continue;
    const debit = asNumber(line.debit);
    const credit = asNumber(line.credit);

    if (isEconomicRevenueActivity(account.type, debit, credit)) {
      recognizedRevenue += plAmountForAccountType(account.type, debit, credit);
    } else if (
      isEconomicIndirectCostLine(account.type, debit, credit, line.cost_classification)
    ) {
      indirectCost += plAmountForAccountType(account.type, debit, credit);
    } else if (isEconomicDirectCostLine(account.type, debit, credit, line.cost_classification)) {
      actualDirectCost += plAmountForAccountType(account.type, debit, credit);
    }
  }

  return {
    recognizedRevenue: roundMoney(recognizedRevenue),
    actualDirectCost: roundMoney(actualDirectCost),
    indirectCost: roundMoney(indirectCost),
  };
}

export function summarizeGlReconciliation(
  lines: JournalLineForJob[],
  accounts: AccountRow[],
  jobId: string,
): { revenue: GlReconciliationSlice; directCost: GlReconciliationSlice } {
  const accountMap = new Map(accounts.map((row) => [row.id, row]));

  function sliceFor(types: string[], economic: (type: string, d: number, c: number, cc?: string | null) => boolean) {
    let glActivity = 0;
    let jobAttributed = 0;
    for (const line of lines) {
      const account = accountMap.get(line.account_id);
      if (!account || !types.includes(account.type)) continue;
      const debit = asNumber(line.debit);
      const credit = asNumber(line.credit);
      if (!economic(account.type, debit, credit, line.cost_classification)) continue;
      const amount = plAmountForAccountType(account.type, debit, credit);
      glActivity += amount;
      if (line.job_id === jobId) jobAttributed += amount;
    }
    glActivity = roundMoney(glActivity);
    jobAttributed = roundMoney(jobAttributed);
    const unassigned = roundMoney(glActivity - jobAttributed);
    return {
      glActivity,
      jobAttributed,
      unassigned,
      difference: unassigned,
    };
  }

  return {
    revenue: sliceFor(["revenue"], isEconomicRevenueActivity),
    directCost: sliceFor(["cogs", "expense"], isEconomicDirectCostLine),
  };
}

const COMMITTED_PO_STATUSES = new Set([
  "approved",
  "sent",
  "partially_received",
  "received",
  "partially_billed",
]);

export async function computeCommittedCostForJob(
  supabase: SupabaseClient,
  organizationId: string,
  jobId: string,
): Promise<{ committedCost: number; remainingCommittedCost: number }> {
  const { data: pos } = await supabase
    .from("teller_purchase_orders")
    .select("id, status")
    .eq("organization_id", organizationId);

  const eligiblePoIds = (pos ?? [])
    .filter((row) => COMMITTED_PO_STATUSES.has(row.status as string))
    .map((row) => row.id as string);

  if (!eligiblePoIds.length) return { committedCost: 0, remainingCommittedCost: 0 };

  const { data: lines } = await supabase
    .from("teller_purchase_order_lines")
    .select("quantity, quantity_billed, unit_cost, job_id, purchase_order_id")
    .eq("organization_id", organizationId)
    .in("purchase_order_id", eligiblePoIds)
    .eq("job_id", jobId);

  let remainingCommittedCost = 0;
  for (const line of lines ?? []) {
    const qty = asNumber(line.quantity);
    const billed = asNumber(line.quantity_billed);
    const unitCost = asNumber(line.unit_cost);
    const unbilled = Math.max(qty - billed, 0);
    remainingCommittedCost += unbilled * unitCost;
  }

  remainingCommittedCost = roundMoney(remainingCommittedCost);
  return { committedCost: remainingCommittedCost, remainingCommittedCost };
}

async function computeCashCollectedForJob(
  supabase: SupabaseClient,
  organizationId: string,
  jobId: string,
): Promise<number> {
  const { data: invoiceLines } = await supabase
    .from("teller_document_lines")
    .select("document_id, job_id, amount")
    .not("job_id", "is", null);

  const docIds = [...new Set((invoiceLines ?? []).map((row) => row.document_id as string))];
  if (!docIds.length) return 0;

  const { data: invoices } = await supabase
    .from("teller_documents")
    .select("id, total, kind, status")
    .eq("organization_id", organizationId)
    .eq("kind", "invoice")
    .in("id", docIds);

  const invoiceMap = new Map((invoices ?? []).map((row) => [row.id as string, row]));

  const { data: allocations } = await supabase
    .from("teller_payment_allocations")
    .select("document_id, amount")
    .eq("organization_id", organizationId)
    .in("document_id", docIds);

  let cashCollected = 0;
  for (const alloc of allocations ?? []) {
    const doc = invoiceMap.get(alloc.document_id as string);
    if (!doc) continue;
    const lines = (invoiceLines ?? []).filter((row) => row.document_id === alloc.document_id);
    const totalApplicable = lines.reduce((sum, row) => sum + asNumber(row.amount), 0);
    const jobAmount = lines
      .filter((row) => row.job_id === jobId)
      .reduce((sum, row) => sum + asNumber(row.amount), 0);
    if (totalApplicable <= 0 || jobAmount <= 0) continue;
    cashCollected += (jobAmount / totalApplicable) * asNumber(alloc.amount);
  }

  return roundMoney(cashCollected);
}

async function computeDepositsHeldForJob(
  supabase: SupabaseClient,
  organizationId: string,
  jobId: string,
): Promise<number> {
  const { data: deposits } = await supabase
    .from("teller_payments")
    .select("id, amount, job_id, payment_type, status")
    .eq("organization_id", organizationId)
    .eq("payment_type", "customer_deposit")
    .eq("status", "posted");

  let held = 0;
  for (const deposit of deposits ?? []) {
    if ((deposit.job_id as string | null) !== jobId) continue;
    const { data: allocs } = await supabase
      .from("teller_payment_allocations")
      .select("amount")
      .eq("payment_id", deposit.id as string);
    const applied = (allocs ?? []).reduce((sum, row) => sum + asNumber(row.amount), 0);
    held += Math.max(asNumber(deposit.amount) - applied, 0);
  }
  return roundMoney(held);
}

async function computeJobArAp(
  supabase: SupabaseClient,
  organizationId: string,
  jobId: string,
  kind: "invoice" | "bill",
): Promise<number> {
  const { data: docs } = await supabase
    .from("teller_documents")
    .select("id, total, status")
    .eq("organization_id", organizationId)
    .eq("kind", kind)
    .in("status", ["open", "partially_paid"]);

  let total = 0;
  for (const doc of docs ?? []) {
    const { data: lines } = await supabase
      .from("teller_document_lines")
      .select("id, job_id, amount")
      .eq("document_id", doc.id as string);
    const remaining = await authoritativeDocumentRemaining(
      supabase,
      organizationId,
      doc.id as string,
      asNumber(doc.total),
    );
    total += allocateDocumentRemainingByJob(
      (lines ?? []).map((row) => ({
        lineId: row.id as string,
        jobId: (row.job_id as string | null) ?? null,
        amount: asNumber(row.amount),
      })),
      jobId,
      remaining,
    );
  }
  return roundMoney(total);
}

export async function buildJobProfitabilitySummary(
  supabase: SupabaseClient,
  organizationId: string,
  jobId: string,
): Promise<JobProfitabilitySummary> {
  const { data: job, error: jobError } = await supabase
    .from("teller_jobs")
    .select(
      "id, organization_id, job_number, name, status, party_id, original_contract_amount, revised_contract_amount, estimated_revenue, estimated_cost, quoted_amount",
    )
    .eq("organization_id", organizationId)
    .eq("id", jobId)
    .maybeSingle();
  if (jobError) throw new Error(jobError.message);
  if (!job) throw new Error("Job not found");

  const [{ data: accounts }, { data: entries }, { data: budgetLines }] = await Promise.all([
    supabase
      .from("teller_accounts")
      .select("id, code, name, type")
      .eq("organization_id", organizationId),
    supabase.from("teller_journal_entries").select("id").eq("organization_id", organizationId),
    supabase
      .from("teller_job_budget_lines")
      .select("estimated_amount")
      .eq("organization_id", organizationId)
      .eq("job_id", jobId),
  ]);

  const entryIds = (entries ?? []).map((row) => row.id as string);
  let orgJournalLines: JournalLineForJob[] = [];
  if (entryIds.length) {
    const { data: journalLines } = await supabase
      .from("teller_journal_lines")
      .select("account_id, debit, credit, job_id, cost_classification, entry_id")
      .in("entry_id", entryIds)
      .not("job_id", "is", null);
    orgJournalLines = journalLines ?? [];
  }

  const jobLines = orgJournalLines.filter((row) => row.job_id === jobId);

  const { recognizedRevenue, actualDirectCost: journalDirectCost, indirectCost } =
    summarizeJournalLinesForJob(jobId, jobLines, accounts ?? []);

  const { data: laborEntries, error: laborError } = await supabase
    .from("teller_labor_entries")
    .select("job_id, gross_amount, employer_burden_amount, labor_type")
    .eq("organization_id", organizationId)
    .eq("job_id", jobId);

  const labor =
    laborError?.message?.includes("teller_labor_entries") ||
    laborError?.code === "42P01"
      ? { directLaborCost: 0, employerLaborBurden: 0, totalLaborCost: 0 }
      : laborError
        ? (() => {
            throw new Error(laborError.message);
          })()
        : summarizeLaborForJob(jobId, laborEntries ?? []);
  const actualDirectCost = computeActualDirectCostWithLabor(
    journalDirectCost,
    labor.directLaborCost,
    labor.employerLaborBurden,
  );

  const glReconciliation = summarizeGlReconciliation(orgJournalLines, accounts ?? [], jobId);

  const estimatedCostFromBudget = roundMoney(
    (budgetLines ?? []).reduce((sum, row) => sum + asNumber(row.estimated_amount), 0),
  );
  const estimatedCost =
    asNumber(job.estimated_cost) > 0 ? asNumber(job.estimated_cost) : estimatedCostFromBudget;

  const { remainingCommittedCost } = await computeCommittedCostForJob(
    supabase,
    organizationId,
    jobId,
  );

  const [cashCollected, customerDepositsHeld, accountsReceivable, accountsPayable] =
    await Promise.all([
      computeCashCollectedForJob(supabase, organizationId, jobId),
      computeDepositsHeldForJob(supabase, organizationId, jobId),
      computeJobArAp(supabase, organizationId, jobId, "invoice"),
      computeJobArAp(supabase, organizationId, jobId, "bill"),
    ]);

  const originalContractAmount = roundMoney(
    asNumber(job.original_contract_amount) || asNumber(job.quoted_amount),
  );
  const revisedContractAmount =
    job.revised_contract_amount == null ? null : roundMoney(asNumber(job.revised_contract_amount));
  const estimatedRevenue = roundMoney(asNumber(job.estimated_revenue));

  const grossProfit = roundMoney(recognizedRevenue - actualDirectCost);
  const remainingBudget = computeRemainingBudget(estimatedCost, actualDirectCost);
  const projectedRevenue = computeProjectedRevenue({
    revisedContractAmount,
    estimatedRevenue,
    recognizedRevenue,
  });
  const projectedCost = computeProjectedCost(
    actualDirectCost,
    remainingBudget,
    remainingCommittedCost,
  );
  const projectedGrossProfit = roundMoney(projectedRevenue - projectedCost);

  return {
    jobId,
    originalContractAmount,
    revisedContractAmount,
    estimatedRevenue,
    recognizedRevenue,
    cashCollected,
    customerDepositsHeld,
    estimatedCost,
    committedCost: remainingCommittedCost,
    remainingCommittedCost,
    actualDirectCost,
    indirectCost,
    directLaborCost: labor.directLaborCost,
    employerLaborBurden: labor.employerLaborBurden,
    totalLaborCost: labor.totalLaborCost,
    grossProfit,
    grossMarginPercent: marginPercent(grossProfit, recognizedRevenue),
    remainingBudget,
    projectedRevenue,
    projectedCost,
    projectedGrossProfit,
    projectedGrossMarginPercent: marginPercent(projectedGrossProfit, projectedRevenue),
    accountsReceivable,
    accountsPayable,
    glReconciliation,
  };
}

/** @deprecated Use buildJobProfitabilitySummary — kept for backward compatibility. */
export function buildJobProfitability(
  jobId: string,
  lines: JournalLineForJob[],
  accounts: AccountRow[],
) {
  const { recognizedRevenue, actualDirectCost, indirectCost } = summarizeJournalLinesForJob(
    jobId,
    lines,
    accounts,
  );
  const grossProfit = roundMoney(recognizedRevenue - actualDirectCost);
  return {
    revenue: recognizedRevenue,
    cogs: actualDirectCost,
    expenses: indirectCost,
    grossProfit,
    netJobProfit: roundMoney(grossProfit - indirectCost),
    revenueLines: [],
    cogsLines: [],
  };
}
