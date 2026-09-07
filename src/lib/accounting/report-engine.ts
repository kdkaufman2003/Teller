import type { SupabaseClient } from "@supabase/supabase-js";
import { buildArAging, buildApAging } from "./aging-service";
import { buildCashFlowStatement } from "./cash-flow-report";
import {
  buildComparativeBalanceSheet,
  buildComparativeProfitAndLoss,
  buildProfitAndLossForPeriod,
} from "./comparative-reports";
import { buildBalanceSheet, buildBalanceSheetFromTotals } from "./financial-reports";
import {
  accountBalancesMapFromTotals,
  depreciationInPeriodFromTotals,
  fetchGlAccountTotals,
  loadCashFlowPeriodLines,
  loadCumulativeTotalsThrough,
  loadLegacyDatedLines,
  loadPeriodTotals,
  salesTaxPayableBalanceFromTotals,
  synthesizePeriodPlLines,
  type GlAccountTotalRow,
  type ReportEngineLine,
} from "./gl-account-totals";
import {
  buildReportContext,
  comparisonRangeForContext,
  dayBefore,
  type ReportContext,
} from "./report-context";
import { buildProfitAndLoss, type AccountRow } from "./reports";
import type {
  CashBasisAllocation,
  CashBasisDocument,
  CashBasisPayment,
} from "./cash-basis-pl";
import { fiscalYearStartDate, parseFiscalYearStart } from "@/lib/org/config";

export type ReportEngineData = {
  accounts: AccountRow[];
  datedLines: ReportEngineLine[];
  entrySourceKinds: Map<string, string | null>;
  usesGlAccountTotalsRpc: boolean;
  cumulativeTotals: GlAccountTotalRow[] | null;
  invoices: CashBasisDocument[];
  billsAndExpenses: CashBasisDocument[];
  payments: CashBasisPayment[];
  allocations: CashBasisAllocation[];
  partyNames: Map<string, string>;
};

const EPOCH_START = "1970-01-01";

async function priorTotalsForRetainedEarnings(
  supabase: SupabaseClient,
  organizationId: string,
  asOfDate: string,
  fiscalYearStartMonth: number,
): Promise<GlAccountTotalRow[] | null> {
  const fyStart = fiscalYearStartDate(
    new Date(`${asOfDate.slice(0, 10)}T12:00:00`),
    parseFiscalYearStart(fiscalYearStartMonth),
  );
  const dayBeforeFy = new Date(fyStart);
  dayBeforeFy.setDate(dayBeforeFy.getDate() - 1);
  const priorEnd = dayBeforeFy.toISOString().slice(0, 10);
  if (priorEnd < EPOCH_START) {
    return fetchGlAccountTotals(supabase, organizationId, EPOCH_START, EPOCH_START);
  }
  return fetchGlAccountTotals(supabase, organizationId, EPOCH_START, priorEnd);
}

export async function loadReportEngineData(
  supabase: SupabaseClient,
  organizationId: string,
  asOfDate: string,
  periodStart: string | null,
): Promise<ReportEngineData> {
  const asOf = asOfDate.slice(0, 10);
  const [{ data: accounts }, subledger] = await Promise.all([
    supabase
      .from("teller_accounts")
      .select("id, code, name, type, subtype, cash_flow_category")
      .eq("organization_id", organizationId)
      .order("code"),
    loadSubledgerData(supabase, organizationId),
  ]);

  const accountRows = (accounts ?? []) as AccountRow[];
  const cumulativeTotals = await loadCumulativeTotalsThrough(supabase, organizationId, asOf);

  if (cumulativeTotals) {
    const { lines: cashFlowPeriodLines, entrySourceKinds } = await loadCashFlowPeriodLines(
      supabase,
      organizationId,
      accountRows,
      periodStart,
      asOf,
    );
    return {
      accounts: accountRows,
      datedLines: cashFlowPeriodLines,
      entrySourceKinds,
      usesGlAccountTotalsRpc: true,
      cumulativeTotals,
      ...subledger,
    };
  }

  const legacy = await loadLegacyDatedLines(supabase, organizationId, asOf);
  return {
    accounts: accountRows,
    datedLines: legacy.datedLines,
    entrySourceKinds: legacy.entrySourceKinds,
    usesGlAccountTotalsRpc: false,
    cumulativeTotals: null,
    ...subledger,
  };
}

async function loadSubledgerData(supabase: SupabaseClient, organizationId: string) {
  const [{ data: documents }, { data: payments }, { data: allocations }, { data: parties }] =
    await Promise.all([
      supabase
        .from("teller_documents")
        .select("id, kind, status, total, issue_date, posted_entry_id")
        .eq("organization_id", organizationId),
      supabase
        .from("teller_payments")
        .select("id, payment_date, payment_type, payment_method, status, amount")
        .eq("organization_id", organizationId)
        .eq("status", "posted"),
      supabase
        .from("teller_payment_allocations")
        .select(
          "payment_id, document_id, amount, allocation_kind, reversed_by_allocation_id, reversal_of_allocation_id",
        )
        .eq("organization_id", organizationId),
      supabase.from("teller_parties").select("id, name").eq("organization_id", organizationId),
    ]);

  const docIds = (documents ?? []).map((d) => d.id as string);
  const { data: docLines } = docIds.length
    ? await supabase
        .from("teller_document_lines")
        .select("document_id, account_id, amount, line_type")
        .in("document_id", docIds)
    : { data: [] };

  const linesByDoc = new Map<string, CashBasisDocument["lines"]>();
  for (const line of docLines ?? []) {
    const docId = line.document_id as string;
    const bucket = linesByDoc.get(docId) ?? [];
    bucket.push({
      account_id: line.account_id as string | null,
      amount: line.amount,
      line_type: line.line_type as string | null,
    });
    linesByDoc.set(docId, bucket);
  }

  const toCashDoc = (row: Record<string, unknown>): CashBasisDocument => ({
    id: row.id as string,
    kind: row.kind as string,
    status: row.status as string,
    total: row.total as number,
    issue_date: row.issue_date as string,
    posted_entry_id: row.posted_entry_id as string | null,
    lines: linesByDoc.get(row.id as string) ?? [],
  });

  return {
    invoices: (documents ?? [])
      .filter((d) => d.kind === "invoice")
      .map((d) => toCashDoc(d as Record<string, unknown>)),
    billsAndExpenses: (documents ?? [])
      .filter((d) => d.kind === "bill" || d.kind === "expense")
      .map((d) => toCashDoc(d as Record<string, unknown>)),
    payments: (payments ?? []).map((p) => ({
      id: p.id as string,
      payment_date: p.payment_date as string,
      payment_type: p.payment_type as string,
      payment_method: p.payment_method as string | null,
      status: p.status as string,
      amount: p.amount,
    })),
    allocations: (allocations ?? []).map((a) => ({
      payment_id: a.payment_id as string,
      document_id: a.document_id as string,
      amount: a.amount,
      allocation_kind: a.allocation_kind as string,
      reversed_by_allocation_id: a.reversed_by_allocation_id as string | null,
      reversal_of_allocation_id: a.reversal_of_allocation_id as string | null,
    })),
    partyNames: new Map((parties ?? []).map((p) => [p.id as string, p.name as string])),
  };
}


export async function buildReportsFromEngine(
  supabase: SupabaseClient,
  ctx: ReportContext,
  data: ReportEngineData,
) {
  const endDate = ctx.endDate ?? ctx.asOfDate;
  let accrualPl: ReturnType<typeof buildProfitAndLoss>;
  let balanceSheet: ReturnType<typeof buildBalanceSheet>;
  let cashFlow: ReturnType<typeof buildCashFlowStatement>;

  if (data.usesGlAccountTotalsRpc && data.cumulativeTotals) {
    const periodTotals = await loadPeriodTotals(
      supabase,
      ctx.organizationId,
      ctx.startDate,
      endDate,
    );
    const priorTotals = await priorTotalsForRetainedEarnings(
      supabase,
      ctx.organizationId,
      ctx.asOfDate,
      ctx.fiscalYearStart,
    );
    const periodLines =
      periodTotals && periodTotals.length
        ? synthesizePeriodPlLines(periodTotals, data.accounts, endDate.slice(0, 10))
        : [];
    accrualPl = buildProfitAndLoss(periodLines, data.accounts);

    balanceSheet = buildBalanceSheetFromTotals({
      cumulativeTotals: data.cumulativeTotals,
      priorTotals: priorTotals ?? [],
      accounts: data.accounts,
      asOf: ctx.asOfDate,
      fiscalYearStartMonth: ctx.fiscalYearStart,
    });

    const cashFlowStart = ctx.startDate ?? endDate;
    const [startBoundaryTotals, endBoundaryTotals, periodDepreciationTotals] = await Promise.all([
      fetchGlAccountTotals(
        supabase,
        ctx.organizationId,
        EPOCH_START,
        dayBefore(cashFlowStart).slice(0, 10),
      ),
      data.cumulativeTotals,
      loadPeriodTotals(supabase, ctx.organizationId, cashFlowStart, endDate),
    ]);

    cashFlow = buildCashFlowStatement({
      lines: data.datedLines,
      accounts: data.accounts,
      startDate: ctx.startDate,
      endDate,
      accrualNetIncome: accrualPl.netIncome,
      entrySourceKinds: data.entrySourceKinds,
      startBalances: startBoundaryTotals
        ? accountBalancesMapFromTotals(startBoundaryTotals, data.accounts)
        : undefined,
      endBalances: endBoundaryTotals
        ? accountBalancesMapFromTotals(endBoundaryTotals, data.accounts)
        : undefined,
      periodDepreciationAddBack: periodDepreciationTotals
        ? depreciationInPeriodFromTotals(periodDepreciationTotals, data.accounts)
        : undefined,
    });
  } else {
    const periodLines = data.datedLines.filter((line) => {
      if (ctx.startDate && line.entry_date < ctx.startDate) return false;
      if (endDate && line.entry_date > endDate) return false;
      return true;
    });
    accrualPl = buildProfitAndLoss(periodLines, data.accounts);
    balanceSheet = buildBalanceSheet(
      data.datedLines,
      data.accounts,
      ctx.asOfDate,
      ctx.fiscalYearStart,
    );
    cashFlow = buildCashFlowStatement({
      lines: data.datedLines,
      accounts: data.accounts,
      startDate: ctx.startDate,
      endDate,
      accrualNetIncome: accrualPl.netIncome,
      entrySourceKinds: data.entrySourceKinds,
    });
  }

  const profitAndLoss = buildProfitAndLossForPeriod({
    basis: ctx.basis,
    lines: data.datedLines,
    accounts: data.accounts,
    startDate: ctx.startDate,
    endDate,
    cashBasis: {
      documents: [...data.invoices, ...data.billsAndExpenses],
      payments: data.payments,
      allocations: data.allocations,
    },
  });
  if (ctx.basis === "accrual") {
    Object.assign(profitAndLoss, accrualPl);
  }

  const comparisonRange = comparisonRangeForContext(ctx);
  let comparativeProfitAndLoss = null;
  let comparativeBalanceSheet = null;

  if (comparisonRange) {
    let comparisonPl = buildProfitAndLossForPeriod({
      basis: ctx.basis,
      lines: data.datedLines,
      accounts: data.accounts,
      startDate: comparisonRange.start,
      endDate: comparisonRange.end,
      cashBasis: {
        documents: [...data.invoices, ...data.billsAndExpenses],
        payments: data.payments,
        allocations: data.allocations,
      },
    });

    if (ctx.basis === "accrual" && data.usesGlAccountTotalsRpc) {
      const comparisonTotals = await loadPeriodTotals(
        supabase,
        ctx.organizationId,
        comparisonRange.start,
        comparisonRange.end ?? comparisonRange.asOf,
      );
      if (comparisonTotals) {
        const comparisonLines = synthesizePeriodPlLines(
          comparisonTotals,
          data.accounts,
          (comparisonRange.end ?? comparisonRange.asOf).slice(0, 10),
        );
        comparisonPl = buildProfitAndLoss(comparisonLines, data.accounts);
      }
    } else if (ctx.basis === "accrual") {
      const comparisonLines = data.datedLines.filter((line) => {
        if (comparisonRange.start && line.entry_date < comparisonRange.start) return false;
        if (comparisonRange.end && line.entry_date > comparisonRange.end) return false;
        return true;
      });
      comparisonPl = buildProfitAndLoss(comparisonLines, data.accounts);
    }

    comparativeProfitAndLoss = buildComparativeProfitAndLoss(profitAndLoss, comparisonPl);

    if (data.usesGlAccountTotalsRpc && data.cumulativeTotals) {
      const comparisonCumulative = await loadCumulativeTotalsThrough(
        supabase,
        ctx.organizationId,
        comparisonRange.asOf,
      );
      const comparisonPrior = await priorTotalsForRetainedEarnings(
        supabase,
        ctx.organizationId,
        comparisonRange.asOf,
        ctx.fiscalYearStart,
      );
      const currentSheet = balanceSheet;
      const comparisonSheet =
        comparisonCumulative && comparisonPrior
          ? buildBalanceSheetFromTotals({
              cumulativeTotals: comparisonCumulative,
              priorTotals: comparisonPrior,
              accounts: data.accounts,
              asOf: comparisonRange.asOf,
              fiscalYearStartMonth: ctx.fiscalYearStart,
            })
          : buildBalanceSheet(
              data.datedLines,
              data.accounts,
              comparisonRange.asOf,
              ctx.fiscalYearStart,
            );
      comparativeBalanceSheet = buildComparativeBalanceSheet(currentSheet, comparisonSheet);
    } else {
      const comparisonSheet = buildBalanceSheet(
        data.datedLines,
        data.accounts,
        comparisonRange.asOf,
        ctx.fiscalYearStart,
      );
      comparativeBalanceSheet = buildComparativeBalanceSheet(balanceSheet, comparisonSheet);
    }
  }

  const openInvoices = data.invoices.map((inv) => ({
    ...inv,
    amount_paid: 0,
    party_id: null,
    due_date: null,
  }));

  return {
    profitAndLoss,
    accrualProfitAndLoss: accrualPl,
    balanceSheet,
    cashFlow,
    comparativeProfitAndLoss,
    comparativeBalanceSheet,
    arAging: buildArAging(openInvoices, data.partyNames, ctx.asOfDate),
    apAging: buildApAging(
      data.billsAndExpenses.map((d) => ({ ...d, amount_paid: 0, party_id: null, due_date: null })),
      data.partyNames,
      ctx.asOfDate,
    ),
  };
}

export function buildReportContextFromParams(input: Parameters<typeof buildReportContext>[0]) {
  return buildReportContext(input);
}

export async function loadSalesTaxPayableBalance(
  supabase: SupabaseClient,
  organizationId: string,
  accounts: AccountRow[],
  asOfDate: string,
  lines: ReportEngineLine[],
): Promise<number> {
  const totals = await loadCumulativeTotalsThrough(supabase, organizationId, asOfDate);
  if (totals) {
    return salesTaxPayableBalanceFromTotals(totals, accounts);
  }

  const taxAccount =
    accounts.find(
      (a) => a.subtype === "tax" || a.code === "2100" || a.name.toLowerCase().includes("sales tax"),
    ) ?? null;
  if (!taxAccount) return 0;
  let balance = 0;
  for (const line of lines) {
    if (line.entry_date > asOfDate || line.account_id !== taxAccount.id) continue;
    balance += Number(line.credit) - Number(line.debit);
  }
  return Math.round(balance * 100) / 100;
}

export { fetchGlAccountTotals, synthesizePeriodPlLines };
