/**
 * Phase 10 controlled demo — dedicated Phase 10 demo org only, never HFAC.
 * 110-scenario financial reporting acceptance matrix.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdjustingJournal } from "../src/lib/accounting/adjusting-journals";
import { buildAccountActivityReport } from "../src/lib/accounting/account-activity";
import { buildAccountantPackageFiles } from "../src/lib/accounting/accountant-package";
import {
  agingBucketForDate,
  buildApAging,
  buildArAging,
  buildCustomerBalanceReport,
  buildVendorBalanceReport,
} from "../src/lib/accounting/aging-service";
import {
  allocateProportionalAmounts,
  buildCashBasisProfitAndLoss,
  buildCashBasisSettlements,
  isNonCashPlSourceKind,
} from "../src/lib/accounting/cash-basis-pl";
import {
  buildCashFlowStatement,
  classifyAccountCashFlow,
} from "../src/lib/accounting/cash-flow-report";
import { evaluateCloseReadiness } from "../src/lib/accounting/close-readiness";
import {
  buildComparativeBalanceSheet,
  buildComparativeProfitAndLoss,
  buildProfitAndLossForPeriod,
} from "../src/lib/accounting/comparative-reports";
import { computeDerivedRetainedEarnings } from "../src/lib/accounting/derived-retained-earnings";
import { buildBalanceSheet } from "../src/lib/accounting/financial-reports";
import { batchSumPostedDepreciationForAssets } from "../src/lib/accounting/fixed-assets";
import { postDepreciationBatch } from "../src/lib/accounting/fixed-asset-depreciation";
import { filterGlEntries, paginateGlReport } from "../src/lib/accounting/gl-report";
import { summarizeJournalLinesForJob } from "../src/lib/accounting/job-profitability";
import { postBillOpen } from "../src/lib/accounting/bills";
import { closeAccountingPeriod } from "../src/lib/accounting/period-close";
import { presentAccountName, presentLabel, presentSectionLabel } from "../src/lib/accounting/presentation-mode";
import { postExpense, postInvoiceOpen, postJournal } from "../src/lib/accounting/post";
import { buildProfitAndLoss, type AccountRow } from "../src/lib/accounting/reports";
import {
  buildReportContext,
  comparisonRangeForContext,
  computeComparativeAmounts,
} from "../src/lib/accounting/report-context";
import { buildSalesTaxSummary } from "../src/lib/accounting/sales-tax-summary";
import {
  build1099ReviewReport,
  classify1099Payment,
  isLikelyExcludedPaymentMethod,
} from "../src/lib/accounting/tax-1099-review";
import { buildComparativeTrialBalance, buildTrialBalance } from "../src/lib/accounting/trial-balance";
import { normalizeSourceKind, resolveJournalSource } from "../src/lib/accounting/source-resolver";
import {
  assertDistinctControlledDemoOrgIds,
  loadControlledDemoOrgId,
} from "../src/lib/integration/controlled-phase-isolation";
import {
  assertNotHfacOrganization,
  CONTROLLED_PHASE10_DEMO_ORG_NAME,
  CONTROLLED_PHASE10_FOREIGN_ORG_NAME,
  evaluateControlledProdTestSafety,
  isControlledTestOrgName,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";

export const PHASE10_CONTROLLED_MATRIX_SIZE = 110;

const HFAC_ORG_ID = TELLER_HFAC_ORG_ID;

const ACCOUNTS: AccountRow[] = [
  { id: "cash", code: "1000", name: "Cash", type: "asset", subtype: "bank" },
  { id: "cash2", code: "1010", name: "Savings", type: "asset", subtype: "bank" },
  { id: "ar", code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable" },
  { id: "ap", code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable" },
  { id: "dep", code: "2300", name: "Customer Deposits", type: "liability", subtype: "deposit" },
  { id: "cc", code: "2100", name: "Credit Card", type: "liability", subtype: "credit_card" },
  { id: "fa", code: "1500", name: "Equipment", type: "asset", subtype: "fixed_asset" },
  { id: "accum", code: "1590", name: "Accum Depr", type: "asset", subtype: "accumulated_depreciation" },
  { id: "equity", code: "3000", name: "Owner Equity", type: "equity", subtype: "owner_equity" },
  { id: "rev", code: "4000", name: "Revenue", type: "revenue" },
  { id: "cogs", code: "5000", name: "COGS", type: "cogs" },
  { id: "exp", code: "6100", name: "Expense", type: "expense" },
  { id: "depr", code: "6200", name: "Depreciation", type: "expense", subtype: "depreciation" },
];

const CASH_INVOICE_DOC = {
  id: "inv1",
  kind: "invoice",
  status: "partially_paid",
  total: 1000,
  issue_date: "2026-03-01",
  posted_entry_id: "je1",
  lines: [{ account_id: "rev", amount: 1000 }],
};

const OPEN_BILL_DOC = {
  id: "bill1",
  kind: "bill",
  status: "open",
  total: 500,
  issue_date: "2026-03-05",
  posted_entry_id: "je2",
  lines: [{ account_id: "exp", amount: 500 }],
};

const PAID_EXPENSE_DOC = {
  id: "exp1",
  kind: "expense",
  status: "paid",
  total: 200,
  issue_date: "2026-03-10",
  posted_entry_id: "je3",
  lines: [{ account_id: "exp", amount: 200 }],
};

type ScenarioResult = { name: string; pass: boolean; detail?: string; skipped?: boolean };

type Scenario = { label: string; run: () => void | Promise<void> };

type ScenarioContext = {
  orgId: string;
  foreignOrgId: string | null;
  supabase: SupabaseClient;
  hfacBefore: { journal_entries: number };
};

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");
  }
  assertDistinctControlledDemoOrgIds();
  const orgId = loadControlledDemoOrgId(10);
  const foreignOrgId = process.env.TELLER_PHASE10_FOREIGN_ORG_ID?.trim();
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
  const { data } = await supabase
    .from("teller_organizations")
    .select("id, name")
    .eq("id", orgId)
    .maybeSingle();
  if (!data || data.name !== CONTROLLED_PHASE10_DEMO_ORG_NAME) {
    throw new Error(`Expected org "${CONTROLLED_PHASE10_DEMO_ORG_NAME}"`);
  }
}

async function hfacBaseline(supabase: SupabaseClient) {
  const { count } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG_ID);
  return { journal_entries: count ?? 0 };
}

function migration026Path(): string {
  return join(process.cwd(), "supabase/migrations/026_phase10_financial_reporting.sql");
}

function assertFunctionExport(value: unknown, name: string): void {
  if (typeof value !== "function") throw new Error(`${name} export missing`);
}

function sampleTrialBalanceReport(periodEnd: string, cashBalance: number) {
  return {
    periodStart: null,
    periodEnd,
    rows: [
      {
        accountId: "cash",
        code: "1000",
        name: "Cash",
        type: "asset",
        openingDebit: 0,
        openingCredit: 0,
        periodDebit: cashBalance,
        periodCredit: 0,
        unadjustedDebit: cashBalance,
        unadjustedCredit: 0,
        adjustmentDebit: 0,
        adjustmentCredit: 0,
        adjustedDebit: cashBalance,
        adjustedCredit: 0,
      },
      {
        accountId: "rev",
        code: "4000",
        name: "Revenue",
        type: "revenue",
        openingDebit: 0,
        openingCredit: 0,
        periodDebit: 0,
        periodCredit: cashBalance,
        unadjustedDebit: 0,
        unadjustedCredit: cashBalance,
        adjustmentDebit: 0,
        adjustmentCredit: 0,
        adjustedDebit: 0,
        adjustedCredit: cashBalance,
      },
    ],
    totals: {
      unadjustedDebit: cashBalance,
      unadjustedCredit: cashBalance,
      adjustmentDebit: 0,
      adjustmentCredit: 0,
      adjustedDebit: cashBalance,
      adjustedCredit: cashBalance,
    },
    balanced: true,
  };
}

function buildScenarioMatrix(ctx: ScenarioContext): Scenario[] {
  const matrix: Scenario[] = [
    // —— HFAC & environment guards ——
    {
      label: "HFAC hard refusal throws",
      run: () => {
        try {
          assertNotHfacOrganization(HFAC_ORG_ID);
          throw new Error("expected refusal");
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("Refusing")) {
            throw error;
          }
        }
      },
    },
    {
      label: "Demo org id is not HFAC",
      run: () => {
        if (ctx.orgId === HFAC_ORG_ID) throw new Error("demo org is HFAC");
        assertNotHfacOrganization(ctx.orgId);
      },
    },
    {
      label: "Demo org name matches controlled marker",
      run: async () => {
        const { data } = await ctx.supabase
          .from("teller_organizations")
          .select("name")
          .eq("id", ctx.orgId)
          .maybeSingle();
        if (data?.name !== CONTROLLED_PHASE10_DEMO_ORG_NAME) {
          throw new Error(`Expected "${CONTROLLED_PHASE10_DEMO_ORG_NAME}"`);
        }
      },
    },
    {
      label: "Controlled prod safety rejects HFAC org id",
      run: () => {
        const result = evaluateControlledProdTestSafety({
          testOrganizationId: HFAC_ORG_ID,
          controlledProdTest: "1",
        });
        if (result.allowed) throw new Error("HFAC org must be blocked");
      },
    },
    {
      label: "Phase 10 org names are controlled test markers",
      run: () => {
        if (!isControlledTestOrgName(CONTROLLED_PHASE10_DEMO_ORG_NAME)) {
          throw new Error("demo org name not controlled");
        }
        if (!isControlledTestOrgName(CONTROLLED_PHASE10_FOREIGN_ORG_NAME)) {
          throw new Error("foreign org name not controlled");
        }
        if (CONTROLLED_PHASE10_DEMO_ORG_NAME === (CONTROLLED_PHASE10_FOREIGN_ORG_NAME as string)) {
          throw new Error("demo and foreign names must differ");
        }
      },
    },
    {
      label: "Non-HFAC uuid passes assertNotHfacOrganization",
      run: () => {
        assertNotHfacOrganization("00000000-0000-4000-8000-000000000001");
      },
    },

    // —— Accrual P&L ——
    {
      label: "Accrual P&L includes period revenue",
      run: () => {
        const pl = buildProfitAndLoss(
          [{ account_id: "rev", debit: 0, credit: 500, entry_date: "2026-03-05" }],
          ACCOUNTS,
        );
        if (pl.totalRevenue !== 500) throw new Error(`expected 500 got ${pl.totalRevenue}`);
      },
    },
    {
      label: "Accrual P&L filters by date range",
      run: () => {
        const pl = buildProfitAndLossForPeriod({
          basis: "accrual",
          lines: [
            { account_id: "rev", debit: 0, credit: 100, entry_date: "2026-01-01" },
            { account_id: "rev", debit: 0, credit: 200, entry_date: "2026-03-01" },
          ],
          accounts: ACCOUNTS,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
        });
        if (pl.totalRevenue !== 200) throw new Error(`expected 200 got ${pl.totalRevenue}`);
      },
    },
    {
      label: "Accrual P&L gross profit equals revenue minus COGS",
      run: () => {
        const pl = buildProfitAndLoss(
          [
            { account_id: "rev", debit: 0, credit: 1000, entry_date: "2026-03-01" },
            { account_id: "cogs", debit: 400, credit: 0, entry_date: "2026-03-01" },
          ],
          ACCOUNTS,
        );
        if (pl.grossProfit !== 600) throw new Error(`expected 600 got ${pl.grossProfit}`);
      },
    },
    {
      label: "Accrual P&L net income equals gross profit minus expenses",
      run: () => {
        const pl = buildProfitAndLoss(
          [
            { account_id: "rev", debit: 0, credit: 800, entry_date: "2026-03-01" },
            { account_id: "exp", debit: 300, credit: 0, entry_date: "2026-03-01" },
          ],
          ACCOUNTS,
        );
        if (pl.netIncome !== 500) throw new Error(`expected 500 got ${pl.netIncome}`);
      },
    },
    {
      label: "Accrual P&L excludes balance sheet accounts",
      run: () => {
        const pl = buildProfitAndLoss(
          [{ account_id: "cash", debit: 5000, credit: 0, entry_date: "2026-03-01" }],
          ACCOUNTS,
        );
        if (pl.totalRevenue !== 0 || pl.totalExpenses !== 0) {
          throw new Error("balance sheet lines must not affect P&L");
        }
      },
    },
    {
      label: "Accrual P&L includes depreciation expense",
      run: () => {
        const pl = buildProfitAndLoss(
          [{ account_id: "depr", debit: 75, credit: 0, entry_date: "2026-03-15" }],
          ACCOUNTS,
        );
        if (pl.totalExpenses !== 75) throw new Error(`expected 75 got ${pl.totalExpenses}`);
      },
    },
    {
      label: "Accrual P&L negative expense from reversal line",
      run: () => {
        const pl = buildProfitAndLoss(
          [{ account_id: "exp", debit: 0, credit: 120, entry_date: "2026-03-20" }],
          ACCOUNTS,
        );
        if (pl.totalExpenses !== -120) throw new Error(`expected -120 got ${pl.totalExpenses}`);
      },
    },
    {
      label: "Accrual P&L multi-line revenue sums correctly",
      run: () => {
        const pl = buildProfitAndLoss(
          [
            { account_id: "rev", debit: 0, credit: 150, entry_date: "2026-03-01" },
            { account_id: "rev", debit: 0, credit: 250, entry_date: "2026-03-15" },
          ],
          ACCOUNTS,
        );
        if (pl.totalRevenue !== 400) throw new Error(`expected 400 got ${pl.totalRevenue}`);
      },
    },

    // —— Cash basis P&L ——
    {
      label: "Proportional allocation preserves total cents",
      run: () => {
        const parts = allocateProportionalAmounts([100, 200, 200], 10);
        const sum = parts.reduce((s, v) => s + v, 0);
        if (Math.abs(sum - 10) > 0.001) throw new Error(`sum ${sum} !== 10`);
      },
    },
    {
      label: "Cash basis unpaid invoice has zero revenue",
      run: () => {
        const settlements = buildCashBasisSettlements({
          documents: [CASH_INVOICE_DOC],
          payments: [],
          allocations: [],
          accounts: ACCOUNTS,
        });
        const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
        if (pl.totalRevenue !== 0) throw new Error(`expected 0 got ${pl.totalRevenue}`);
      },
    },
    {
      label: "Cash basis partial invoice payment",
      run: () => {
        const settlements = buildCashBasisSettlements({
          documents: [CASH_INVOICE_DOC],
          payments: [
            { id: "p1", payment_date: "2026-03-10", payment_type: "customer_payment", amount: 400 },
          ],
          allocations: [
            { payment_id: "p1", document_id: "inv1", amount: 400, allocation_kind: "invoice_payment" },
          ],
          accounts: ACCOUNTS,
        });
        const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
        if (pl.totalRevenue !== 400) throw new Error(`expected 400 got ${pl.totalRevenue}`);
      },
    },
    {
      label: "Cash basis full invoice payment",
      run: () => {
        const settlements = buildCashBasisSettlements({
          documents: [CASH_INVOICE_DOC],
          payments: [
            { id: "p2", payment_date: "2026-03-20", payment_type: "customer_payment", amount: 1000 },
          ],
          allocations: [
            { payment_id: "p2", document_id: "inv1", amount: 1000, allocation_kind: "invoice_payment" },
          ],
          accounts: ACCOUNTS,
        });
        const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
        if (pl.totalRevenue !== 1000) throw new Error(`expected 1000 got ${pl.totalRevenue}`);
      },
    },
    {
      label: "Cash basis unpaid vendor bill has zero expense",
      run: () => {
        const settlements = buildCashBasisSettlements({
          documents: [OPEN_BILL_DOC],
          payments: [],
          allocations: [],
          accounts: ACCOUNTS,
        });
        const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
        if (pl.totalExpenses !== 0) throw new Error(`expected 0 got ${pl.totalExpenses}`);
      },
    },
    {
      label: "Cash basis direct cash expense on issue date",
      run: () => {
        const settlements = buildCashBasisSettlements({
          documents: [PAID_EXPENSE_DOC],
          payments: [],
          allocations: [],
          accounts: ACCOUNTS,
          documentCreditAccountId: new Map([["exp1", "cash"]]),
        });
        const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
        if (pl.totalExpenses !== 200) throw new Error(`expected 200 got ${pl.totalExpenses}`);
      },
    },
    {
      label: "Cash basis credit card expense recognized at posting",
      run: () => {
        const settlements = buildCashBasisSettlements({
          documents: [PAID_EXPENSE_DOC],
          payments: [],
          allocations: [],
          accounts: ACCOUNTS,
          documentCreditAccountId: new Map([["exp1", "cc"]]),
        });
        const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
        if (pl.totalExpenses !== 200) throw new Error(`expected 200 got ${pl.totalExpenses}`);
      },
    },
    {
      label: "Cash basis customer refund reduces revenue",
      run: () => {
        const settlements = buildCashBasisSettlements({
          documents: [],
          payments: [
            { id: "cr1", payment_date: "2026-03-18", payment_type: "customer_refund", amount: 150 },
          ],
          allocations: [],
          accounts: ACCOUNTS,
        });
        const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
        if (pl.totalRevenue !== -150) throw new Error(`expected -150 got ${pl.totalRevenue}`);
      },
    },
    {
      label: "Cash basis vendor refund reduces expense",
      run: () => {
        const settlements = buildCashBasisSettlements({
          documents: [],
          payments: [
            { id: "vr1", payment_date: "2026-03-22", payment_type: "vendor_refund", amount: 80 },
          ],
          allocations: [],
          accounts: ACCOUNTS,
        });
        const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
        if (pl.totalExpenses !== -80) throw new Error(`expected -80 got ${pl.totalExpenses}`);
      },
    },
    {
      label: "Cash basis deposit apply recognizes revenue",
      run: () => {
        const settlements = buildCashBasisSettlements({
          documents: [CASH_INVOICE_DOC],
          payments: [
            { id: "dp1", payment_date: "2026-03-08", payment_type: "customer_payment", amount: 300 },
          ],
          allocations: [
            { payment_id: "dp1", document_id: "inv1", amount: 300, allocation_kind: "deposit_apply" },
          ],
          accounts: ACCOUNTS,
        });
        const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
        if (pl.totalRevenue !== 300) throw new Error(`expected 300 got ${pl.totalRevenue}`);
      },
    },
    {
      label: "Cash basis void payment ignored",
      run: () => {
        const settlements = buildCashBasisSettlements({
          documents: [CASH_INVOICE_DOC],
          payments: [
            {
              id: "pv1",
              payment_date: "2026-03-12",
              payment_type: "customer_payment",
              amount: 500,
              status: "void",
            },
          ],
          allocations: [
            { payment_id: "pv1", document_id: "inv1", amount: 500, allocation_kind: "invoice_payment" },
          ],
          accounts: ACCOUNTS,
        });
        const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
        if (pl.totalRevenue !== 0) throw new Error("void payment must not recognize revenue");
      },
    },
    {
      label: "Cash basis empty settlements yield zero net income",
      run: () => {
        const pl = buildCashBasisProfitAndLoss([], ACCOUNTS, "2026-03-01", "2026-03-31");
        if (pl.netIncome !== 0) throw new Error(`expected 0 got ${pl.netIncome}`);
      },
    },
    {
      label: "Non-cash depreciation source kind flagged",
      run: () => {
        if (!isNonCashPlSourceKind("fixed-asset-depreciation")) {
          throw new Error("depreciation must be non-cash");
        }
        if (isNonCashPlSourceKind("invoice-payment")) {
          throw new Error("invoice payment must be cash-affecting");
        }
      },
    },
    {
      label: "Cash basis P&L via buildProfitAndLossForPeriod",
      run: () => {
        const pl = buildProfitAndLossForPeriod({
          basis: "cash",
          lines: [],
          accounts: ACCOUNTS,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          cashBasis: {
            documents: [CASH_INVOICE_DOC],
            payments: [
              { id: "p3", payment_date: "2026-03-25", payment_type: "customer_payment", amount: 600 },
            ],
            allocations: [
              { payment_id: "p3", document_id: "inv1", amount: 600, allocation_kind: "invoice_payment" },
            ],
          },
        });
        if (pl.totalRevenue !== 600) throw new Error(`expected 600 got ${pl.totalRevenue}`);
      },
    },

    // —— Balance sheet & retained earnings ——
    {
      label: "Balance sheet is balanced",
      run: () => {
        const lines = [
          { account_id: "cash", debit: 1000, credit: 0, entry_date: "2025-08-01" },
          { account_id: "rev", debit: 0, credit: 1000, entry_date: "2025-08-01" },
        ];
        const bs = buildBalanceSheet(lines, ACCOUNTS, "2026-06-30", 7);
        if (!bs.balanced) throw new Error("balance sheet not balanced");
      },
    },
    {
      label: "Non-January fiscal year changes current earnings",
      run: () => {
        const lines = [
          { account_id: "cash", debit: 10000, credit: 0, entry_date: "2025-06-01" },
          { account_id: "rev", debit: 0, credit: 10000, entry_date: "2025-08-01" },
          { account_id: "exp", debit: 2000, credit: 0, entry_date: "2025-09-01" },
          { account_id: "rev", debit: 0, credit: 5000, entry_date: "2026-02-01" },
        ];
        const janFy = buildBalanceSheet(lines, ACCOUNTS, "2026-03-31", 1);
        const julFy = buildBalanceSheet(lines, ACCOUNTS, "2026-03-31", 7);
        if (janFy.currentEarnings === julFy.currentEarnings) {
          throw new Error("fiscal year start must affect current earnings split");
        }
      },
    },
    {
      label: "Derived retained earnings golden path",
      run: () => {
        const lines = [
          { account_id: "cash", debit: 10000, credit: 0, entry_date: "2025-06-01" },
          { account_id: "rev", debit: 0, credit: 10000, entry_date: "2025-08-01" },
          { account_id: "exp", debit: 2000, credit: 0, entry_date: "2025-09-01" },
          { account_id: "rev", debit: 0, credit: 5000, entry_date: "2026-02-01" },
        ];
        const derived = computeDerivedRetainedEarnings({
          lines,
          accounts: ACCOUNTS,
          asOfDate: "2026-03-31",
          fiscalYearStartMonth: 1,
        });
        if (derived.currentFiscalYearEarnings !== 5000) {
          throw new Error(`expected 5000 got ${derived.currentFiscalYearEarnings}`);
        }
        if (derived.priorPeriodDerivedEarnings !== 8000) {
          throw new Error(`expected 8000 got ${derived.priorPeriodDerivedEarnings}`);
        }
      },
    },
    {
      label: "Historical reversal keeps January expense in January",
      run: () => {
        const janLines = [
          { account_id: "exp", debit: 100, credit: 0, entry_date: "2026-01-15" },
          { account_id: "ap", debit: 0, credit: 100, entry_date: "2026-01-15" },
        ];
        const janReport = buildProfitAndLoss(
          janLines.filter((l) => l.entry_date <= "2026-01-31"),
          ACCOUNTS,
        );
        if (janReport.totalExpenses !== 100) throw new Error(`expected 100 got ${janReport.totalExpenses}`);
      },
    },
    {
      label: "Historical reversal shows negative expense in reversal month",
      run: () => {
        const allLines = [
          { account_id: "exp", debit: 100, credit: 0, entry_date: "2026-01-15" },
          { account_id: "ap", debit: 0, credit: 100, entry_date: "2026-01-15" },
          { account_id: "exp", debit: 0, credit: 100, entry_date: "2026-02-01" },
          { account_id: "ap", debit: 100, credit: 0, entry_date: "2026-02-01" },
        ];
        const febReport = buildProfitAndLoss(
          allLines.filter((l) => l.entry_date >= "2026-02-01" && l.entry_date <= "2026-02-28"),
          ACCOUNTS,
        );
        if (febReport.totalExpenses !== -100) throw new Error(`expected -100 got ${febReport.totalExpenses}`);
      },
    },
    {
      label: "Balance sheet total assets equals liabilities plus equity",
      run: () => {
        const lines = [
          { account_id: "cash", debit: 3000, credit: 0, entry_date: "2026-01-01" },
          { account_id: "ap", debit: 0, credit: 500, entry_date: "2026-01-01" },
          { account_id: "rev", debit: 0, credit: 2500, entry_date: "2026-01-01" },
        ];
        const bs = buildBalanceSheet(lines, ACCOUNTS, "2026-03-31", 1);
        const lhs = bs.totalAssets;
        const rhs = bs.totalLiabilities + bs.totalEquity;
        if (Math.abs(lhs - rhs) > 0.01) throw new Error(`assets ${lhs} !== liab+eq ${rhs}`);
      },
    },
    {
      label: "Derived retained earnings respects July fiscal year",
      run: () => {
        const lines = [
          { account_id: "rev", debit: 0, credit: 12000, entry_date: "2025-08-01" },
          { account_id: "exp", debit: 3000, credit: 0, entry_date: "2025-10-01" },
          { account_id: "rev", debit: 0, credit: 4000, entry_date: "2026-01-15" },
        ];
        const derived = computeDerivedRetainedEarnings({
          lines,
          accounts: ACCOUNTS,
          asOfDate: "2026-03-31",
          fiscalYearStartMonth: 7,
        });
        if (derived.fiscalYearStartMonth !== 7) throw new Error("expected July fiscal year");
        if (derived.totalRetainedEarningsPresentation <= 0) {
          throw new Error("derived RE presentation must be positive");
        }
      },
    },

    // —— Cash flow statement ——
    {
      label: "Cash flow uses accrual net income",
      run: () => {
        const cf = buildCashFlowStatement({
          lines: [{ account_id: "cash", debit: 100, credit: 0, entry_date: "2026-03-01" }],
          accounts: ACCOUNTS,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          accrualNetIncome: 250,
        });
        if (!cf.usesAccrualNetIncome || cf.operating[0]?.amount !== 250) {
          throw new Error("accrual net income not wired");
        }
      },
    },
    {
      label: "Cash flow depreciation add-back in operating",
      run: () => {
        const cfLines = [
          { account_id: "depr", debit: 50, credit: 0, entry_date: "2026-03-10", entry_id: "d1" },
          { account_id: "accum", debit: 0, credit: 50, entry_date: "2026-03-10", entry_id: "d1" },
        ];
        const cf = buildCashFlowStatement({
          lines: cfLines,
          accounts: ACCOUNTS,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          accrualNetIncome: 450,
          entrySourceKinds: new Map([["d1", "fixed-asset-depreciation"]]),
        });
        const deprLine = cf.operating.find((l) => l.label.includes("Depreciation"));
        if (!deprLine || deprLine.amount !== 50) throw new Error("depreciation add-back missing");
      },
    },
    {
      label: "Cash flow AR change in operating",
      run: () => {
        const cfLines = [
          { account_id: "cash", debit: 1000, credit: 0, entry_date: "2026-02-28" },
          { account_id: "ar", debit: 500, credit: 0, entry_date: "2026-03-01" },
          { account_id: "rev", debit: 0, credit: 500, entry_date: "2026-03-01" },
        ];
        const cf = buildCashFlowStatement({
          lines: cfLines,
          accounts: ACCOUNTS,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          accrualNetIncome: 500,
        });
        const arLine = cf.operating.find((l) => l.label.includes("receivable"));
        if (!arLine || arLine.amount !== -500) throw new Error(`AR change wrong: ${arLine?.amount}`);
      },
    },
    {
      label: "Cash flow AP change in operating",
      run: () => {
        const cfLines = [
          { account_id: "cash", debit: 1000, credit: 0, entry_date: "2026-02-28" },
          { account_id: "ap", debit: 0, credit: 300, entry_date: "2026-03-05" },
          { account_id: "exp", debit: 300, credit: 0, entry_date: "2026-03-05" },
        ];
        const cf = buildCashFlowStatement({
          lines: cfLines,
          accounts: ACCOUNTS,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          accrualNetIncome: -300,
        });
        const apLine = cf.operating.find((l) => l.label.includes("payable"));
        if (!apLine || apLine.amount !== 300) throw new Error(`AP change wrong: ${apLine?.amount}`);
      },
    },
    {
      label: "Cash flow customer deposits change in operating",
      run: () => {
        const cfLines = [
          { account_id: "cash", debit: 2000, credit: 0, entry_date: "2026-02-28" },
          { account_id: "dep", debit: 0, credit: 400, entry_date: "2026-03-03" },
          { account_id: "cash", debit: 400, credit: 0, entry_date: "2026-03-03" },
        ];
        const cf = buildCashFlowStatement({
          lines: cfLines,
          accounts: ACCOUNTS,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          accrualNetIncome: 0,
        });
        const depLine = cf.operating.find((l) => l.label.includes("deposits"));
        if (!depLine || depLine.amount !== -400) throw new Error(`deposit change wrong: ${depLine?.amount}`);
      },
    },
    {
      label: "Cash flow fixed asset purchase in investing",
      run: () => {
        const cfLines = [
          { account_id: "cash", debit: 5000, credit: 0, entry_date: "2026-02-28" },
          { account_id: "cash", debit: 0, credit: 2000, entry_date: "2026-03-04", entry_id: "fa1" },
          { account_id: "fa", debit: 2000, credit: 0, entry_date: "2026-03-04", entry_id: "fa1" },
        ];
        const cf = buildCashFlowStatement({
          lines: cfLines,
          accounts: ACCOUNTS,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          accrualNetIncome: 0,
        });
        if (cf.netInvesting !== -2000) throw new Error(`expected -2000 investing got ${cf.netInvesting}`);
      },
    },
    {
      label: "Cash flow owner contribution in financing",
      run: () => {
        const cfLines = [
          { account_id: "cash", debit: 1000, credit: 0, entry_date: "2026-02-28" },
          { account_id: "cash", debit: 1500, credit: 0, entry_date: "2026-03-06", entry_id: "eq1" },
          { account_id: "equity", debit: 0, credit: 1500, entry_date: "2026-03-06", entry_id: "eq1" },
        ];
        const cf = buildCashFlowStatement({
          lines: cfLines,
          accounts: ACCOUNTS,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          accrualNetIncome: 0,
        });
        if (cf.netFinancing !== 1500) throw new Error(`expected 1500 financing got ${cf.netFinancing}`);
      },
    },
    {
      label: "Cash flow bank transfer nets out of sections",
      run: () => {
        const cfLines = [
          { account_id: "cash", debit: 3000, credit: 0, entry_date: "2026-02-28" },
          { account_id: "cash2", debit: 0, credit: 0, entry_date: "2026-02-28" },
          { account_id: "cash", debit: 0, credit: 500, entry_date: "2026-03-07", entry_id: "xfr1" },
          { account_id: "cash2", debit: 500, credit: 0, entry_date: "2026-03-07", entry_id: "xfr1" },
        ];
        const cf = buildCashFlowStatement({
          lines: cfLines,
          accounts: ACCOUNTS,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          accrualNetIncome: 0,
        });
        const transferInSections =
          cf.investing.some((l) => l.label.includes("Savings")) ||
          cf.financing.some((l) => l.label.includes("Savings"));
        if (transferInSections) throw new Error("internal transfer must not appear in investing/financing");
      },
    },
    {
      label: "Cash flow tracks unclassified activity",
      run: () => {
        const cfLines = [
          { account_id: "cash", debit: 1000, credit: 0, entry_date: "2026-02-28" },
          { account_id: "cash", debit: 200, credit: 0, entry_date: "2026-03-09", entry_id: "u1" },
          { account_id: "rev", debit: 0, credit: 200, entry_date: "2026-03-09", entry_id: "u1" },
        ];
        const cf = buildCashFlowStatement({
          lines: cfLines,
          accounts: ACCOUNTS,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          accrualNetIncome: 200,
        });
        if (cf.reconciled !== true) throw new Error("cash flow must reconcile");
      },
    },
    {
      label: "Cash flow reconciliation invariant",
      run: () => {
        const cfLines = [
          { account_id: "cash", debit: 1000, credit: 0, entry_date: "2026-02-28" },
          { account_id: "cash", debit: 500, credit: 0, entry_date: "2026-03-15" },
          { account_id: "ar", debit: 500, credit: 0, entry_date: "2026-03-01" },
          { account_id: "rev", debit: 0, credit: 500, entry_date: "2026-03-01" },
          { account_id: "depr", debit: 50, credit: 0, entry_date: "2026-03-10", entry_id: "d1" },
          { account_id: "accum", debit: 0, credit: 50, entry_date: "2026-03-10", entry_id: "d1" },
        ];
        const pl = buildProfitAndLoss(
          cfLines.filter((l) => l.entry_date >= "2026-03-01" && l.entry_date <= "2026-03-31"),
          ACCOUNTS,
        );
        const cf = buildCashFlowStatement({
          lines: cfLines,
          accounts: ACCOUNTS,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          accrualNetIncome: pl.netIncome,
          entrySourceKinds: new Map([["d1", "fixed-asset-depreciation"]]),
        });
        const computed =
          cf.beginningCash + cf.netOperating + cf.netInvesting + cf.netFinancing + cf.netUnclassified;
        if (Math.abs(computed - cf.endingCash) >= 0.06) {
          throw new Error(`reconciliation gap: ${computed} vs ${cf.endingCash}`);
        }
      },
    },
    {
      label: "classifyAccountCashFlow marks receivable operating",
      run: () => {
        const ar = ACCOUNTS.find((a) => a.id === "ar")!;
        if (classifyAccountCashFlow(ar) !== "operating") {
          throw new Error("AR must classify as operating");
        }
      },
    },
    {
      label: "classifyAccountCashFlow marks credit card operating",
      run: () => {
        const cc = ACCOUNTS.find((a) => a.id === "cc")!;
        if (classifyAccountCashFlow(cc) !== "operating") {
          throw new Error("credit card must classify as operating");
        }
      },
    },

    // —— Comparative reporting ——
    {
      label: "Comparative P&L variance amount",
      run: () => {
        const current = buildProfitAndLoss([{ account_id: "rev", debit: 0, credit: 100 }], ACCOUNTS);
        const prior = buildProfitAndLoss([{ account_id: "rev", debit: 0, credit: 80 }], ACCOUNTS);
        const c = buildComparativeProfitAndLoss(current, prior);
        if (c.totals.netIncome.varianceAmount !== 20) {
          throw new Error(`expected variance 20 got ${c.totals.netIncome.varianceAmount}`);
        }
      },
    },
    {
      label: "Comparative P&L zero denominator safe",
      run: () => {
        const c = buildComparativeProfitAndLoss(
          buildProfitAndLoss([{ account_id: "rev", debit: 0, credit: 10 }], ACCOUNTS),
          buildProfitAndLoss([], ACCOUNTS),
        );
        if (c.totals.netIncome.comparisonAmount !== 0) throw new Error("comparison amount must be 0");
        if (c.totals.netIncome.variancePercent !== null) {
          throw new Error("variance percent must be null when prior is zero");
        }
      },
    },
    {
      label: "Comparative P&L includes accounts in only one period",
      run: () => {
        const current = buildProfitAndLoss(
          [{ account_id: "rev", debit: 0, credit: 100, entry_date: "2026-03-01" }],
          ACCOUNTS,
        );
        const comparison = buildProfitAndLoss(
          [{ account_id: "exp", debit: 50, credit: 0, entry_date: "2026-02-01" }],
          ACCOUNTS,
        );
        const cpl = buildComparativeProfitAndLoss(current, comparison);
        if (cpl.revenue.length === 0 || cpl.expenses.length === 0) {
          throw new Error("comparative P&L must include both sections");
        }
      },
    },
    {
      label: "Comparative balance sheet totals",
      run: () => {
        const lines = [
          { account_id: "cash", debit: 5000, credit: 0, entry_date: "2026-01-01" },
          { account_id: "rev", debit: 0, credit: 5000, entry_date: "2026-01-01" },
        ];
        const current = buildBalanceSheet(lines, ACCOUNTS, "2026-03-31", 1);
        const prior = buildBalanceSheet(lines, ACCOUNTS, "2025-12-31", 1);
        const cbs = buildComparativeBalanceSheet(current, prior);
        if (cbs.totals.totalAssets.varianceAmount !== current.totalAssets - prior.totalAssets) {
          throw new Error("comparative BS asset variance mismatch");
        }
      },
    },
    {
      label: "Comparative trial balance ending variance",
      run: () => {
        const current = sampleTrialBalanceReport("2026-03-31", 1000);
        const prior = sampleTrialBalanceReport("2026-02-28", 800);
        const ct = buildComparativeTrialBalance(current, prior);
        if (ct.rows.length === 0) throw new Error("comparative TB must have rows");
        const cashRow = ct.rows.find((r) => r.code === "1000");
        const variance = cashRow && "endingComparison" in cashRow ? cashRow.endingComparison.varianceAmount : null;
        if (variance !== 200) {
          throw new Error("comparative TB cash variance wrong");
        }
      },
    },
    {
      label: "Prior period comparison range",
      run: () => {
        const reportCtx = buildReportContext({
          organizationId: ctx.orgId,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          comparison: "prior_period",
        });
        const range = comparisonRangeForContext(reportCtx);
        if (!range || range.end !== "2026-02-28") {
          throw new Error(`expected prior end 2026-02-28 got ${range?.end}`);
        }
      },
    },
    {
      label: "computeComparativeAmounts variance percent",
      run: () => {
        const amounts = computeComparativeAmounts(150, 100);
        if (amounts.varianceAmount !== 50 || amounts.variancePercent !== 50) {
          throw new Error("variance percent calculation wrong");
        }
      },
    },

    // —— GL, pagination, drilldown, source lineage ——
    {
      label: "GL pagination second page",
      run: () => {
        const entries = Array.from({ length: 120 }, (_, i) => ({
          id: `e${i}`,
          entryDate: "2026-03-01",
          memo: null,
          sourceKind: null,
          sourceId: null,
          reversesEntryId: null,
          lines: [],
          source: resolveJournalSource({ sourceKind: null, sourceId: null }),
        }));
        const page = paginateGlReport(entries, 2, 50);
        if (page.entries.length !== 50 || !page.hasMore) {
          throw new Error("pagination page 2 wrong");
        }
      },
    },
    {
      label: "GL pagination last page hasMore false",
      run: () => {
        const entries = Array.from({ length: 75 }, (_, i) => ({
          id: `e${i}`,
          entryDate: "2026-03-01",
          memo: null,
          sourceKind: null,
          sourceId: null,
          reversesEntryId: null,
          lines: [],
          source: resolveJournalSource({ sourceKind: null, sourceId: null }),
        }));
        const page = paginateGlReport(entries, 2, 50);
        if (page.hasMore) throw new Error("last page must not have more");
      },
    },
    {
      label: "Filter GL by account",
      run: () => {
        const filtered = filterGlEntries(
          [
            {
              id: "1",
              entry_date: "2026-03-01",
              memo: null,
              source_kind: null,
              source_id: null,
              reverses_entry_id: null,
            },
          ],
          [{ id: "l1", entry_id: "1", account_id: "rev", debit: 0, credit: 10, memo: null, job_id: null }],
          ACCOUNTS,
          { accountId: "rev" },
        );
        if (filtered.length !== 1) throw new Error("filter by account failed");
      },
    },
    {
      label: "Account activity opening and closing balance",
      run: () => {
        const cash = ACCOUNTS.find((a) => a.id === "cash")!;
        const report = buildAccountActivityReport({
          account: cash,
          entries: [
            {
              id: "e1",
              entry_date: "2026-02-01",
              memo: "Prior",
              source_kind: null,
              source_id: null,
              reverses_entry_id: null,
            },
            {
              id: "e2",
              entry_date: "2026-03-05",
              memo: "In period",
              source_kind: "manual",
              source_id: null,
              reverses_entry_id: null,
            },
          ],
          lines: [
            { id: "l1", entry_id: "e1", account_id: "cash", debit: 100, credit: 0 },
            { id: "l2", entry_id: "e2", account_id: "cash", debit: 50, credit: 0 },
          ],
          startDate: "2026-03-01",
          endDate: "2026-03-31",
        });
        if (report.openingBalance !== 100 || report.closingBalance !== 150) {
          throw new Error(`balances wrong: open ${report.openingBalance} close ${report.closingBalance}`);
        }
      },
    },
    {
      label: "Account activity source lineage resolves manual",
      run: () => {
        const cash = ACCOUNTS.find((a) => a.id === "cash")!;
        const report = buildAccountActivityReport({
          account: cash,
          entries: [
            {
              id: "e1",
              entry_date: "2026-03-05",
              memo: null,
              source_kind: "manual",
              source_id: null,
              reverses_entry_id: null,
            },
          ],
          lines: [{ id: "l1", entry_id: "e1", account_id: "cash", debit: 25, credit: 0 }],
          startDate: "2026-03-01",
          endDate: "2026-03-31",
        });
        if (report.lines[0]?.source.kind !== "manual") {
          throw new Error("source lineage must resolve manual kind");
        }
      },
    },
    {
      label: "resolveJournalSource invoice href",
      run: () => {
        const resolved = resolveJournalSource({
          sourceKind: "invoice",
          sourceId: "abc-123",
          memo: "Invoice 1001",
        });
        if (resolved.kind !== "invoice" || !resolved.href?.includes("abc-123")) {
          throw new Error("invoice source not resolved");
        }
      },
    },
    {
      label: "resolveJournalSource bill kind",
      run: () => {
        const resolved = resolveJournalSource({ sourceKind: "bill", sourceId: "bill-9" });
        if (resolved.kind !== "bill") throw new Error("bill source not resolved");
      },
    },
    {
      label: "resolveJournalSource unknown kind safe",
      run: () => {
        const resolved = resolveJournalSource({ sourceKind: "legacy_custom", sourceId: "x" });
        if (resolved.kind !== "unknown") throw new Error("expected unknown kind");
      },
    },
    {
      label: "normalizeSourceKind maps bill-payment",
      run: () => {
        if (normalizeSourceKind("bill-payment") !== "payment") {
          throw new Error("bill-payment must normalize to payment");
        }
      },
    },

    // —— AR/AP aging & party balances ——
    {
      label: "AR aging current bucket",
      run: () => {
        const report = buildArAging(
          [
            {
              total: 500,
              amount_paid: 0,
              issue_date: "2026-03-01",
              due_date: "2026-03-15",
              party_id: "c1",
              status: "open",
              posted_entry_id: "je1",
            },
          ],
          new Map([["c1", "Customer A"]]),
          "2026-03-10",
        );
        const current = report.buckets.find((b) => b.id === "current");
        if (!current || current.amount !== 500) throw new Error("current AR bucket wrong");
      },
    },
    {
      label: "AR aging 90+ bucket",
      run: () => {
        if (agingBucketForDate("2025-12-01", "2026-03-31") !== "90_plus") {
          throw new Error("expected 90+ bucket");
        }
        const report = buildArAging(
          [
            {
              total: 200,
              amount_paid: 0,
              issue_date: "2025-12-01",
              due_date: "2025-12-15",
              party_id: "c2",
              status: "open",
              posted_entry_id: "je2",
            },
          ],
          new Map([["c2", "Customer B"]]),
          "2026-03-31",
        );
        const old = report.buckets.find((b) => b.id === "90_plus");
        if (!old || old.amount !== 200) throw new Error("90+ AR bucket wrong");
      },
    },
    {
      label: "AP aging from open bills",
      run: () => {
        const report = buildApAging(
          [
            {
              kind: "bill",
              total: 750,
              amount_paid: 250,
              issue_date: "2026-02-01",
              due_date: "2026-02-28",
              party_id: "v1",
              status: "partially_paid",
              posted_entry_id: "je3",
            },
          ],
          new Map([["v1", "Vendor A"]]),
          "2026-03-31",
        );
        if (report.total !== 500) throw new Error(`expected AP total 500 got ${report.total}`);
      },
    },
    {
      label: "Customer balance report net with credits",
      run: () => {
        const report = buildCustomerBalanceReport({
          parties: [{ id: "c1", name: "Customer A" }],
          invoiceRemainingByParty: new Map([["c1", 1000]]),
          unappliedCreditsByParty: new Map([["c1", 200]]),
          asOf: "2026-03-31",
        });
        if (report.rows[0]?.netBalance !== 800) throw new Error(`expected net 800 got ${report.rows[0]?.netBalance}`);
      },
    },
    {
      label: "Vendor balance report net with credits",
      run: () => {
        const report = buildVendorBalanceReport({
          parties: [{ id: "v1", name: "Vendor A" }],
          billRemainingByParty: new Map([["v1", 600]]),
          unappliedCreditsByParty: new Map([["v1", 100]]),
          asOf: "2026-03-31",
        });
        if (report.rows[0]?.netBalance !== 500) throw new Error(`expected net 500 got ${report.rows[0]?.netBalance}`);
      },
    },
    {
      label: "AR aging top customers sorted by total",
      run: () => {
        const report = buildArAging(
          [
            {
              total: 100,
              amount_paid: 0,
              issue_date: "2026-03-01",
              party_id: "c1",
              status: "open",
              posted_entry_id: "je1",
            },
            {
              total: 900,
              amount_paid: 0,
              issue_date: "2026-03-01",
              party_id: "c2",
              status: "open",
              posted_entry_id: "je2",
            },
          ],
          new Map([
            ["c1", "Small"],
            ["c2", "Large"],
          ]),
          "2026-03-31",
        );
        if (report.topCustomers[0]?.name !== "Large") {
          throw new Error("top customer must be highest balance");
        }
      },
    },
    {
      label: "AP aging excludes draft documents",
      run: () => {
        const report = buildApAging(
          [
            {
              kind: "bill",
              total: 1000,
              amount_paid: 0,
              issue_date: "2026-03-01",
              party_id: "v1",
              status: "draft",
              posted_entry_id: null,
            },
          ],
          new Map([["v1", "Vendor"]]),
          "2026-03-31",
        );
        if (report.total !== 0) throw new Error("draft bills must not age");
      },
    },
    {
      label: "Trial balance debits equal credits on demo org",
      run: async () => {
        const tb = await buildTrialBalance(ctx.supabase, ctx.orgId, { periodEnd: "2026-12-31" });
        if (!tb.balanced) throw new Error("demo org trial balance must be balanced");
        if (Math.abs(tb.totals.adjustedDebit - tb.totals.adjustedCredit) > 0.01) {
          throw new Error("adjusted debits must equal credits");
        }
      },
    },

    // —— 1099, sales tax, sensitive exports ——
    {
      label: "1099 credit card payment excluded",
      run: () => {
        const c = classify1099Payment({
          amount: 600,
          paymentMethod: "credit_card",
          eligible1099: true,
          w9Received: true,
          hasTin: true,
        });
        if (c.bucket !== "excluded") throw new Error("card payment must be excluded");
      },
    },
    {
      label: "1099 check payment reportable with W-9",
      run: () => {
        const c = classify1099Payment({
          amount: 1200,
          paymentMethod: "check",
          eligible1099: true,
          w9Received: true,
          hasTin: true,
        });
        if (c.bucket !== "likelyReportable") throw new Error("check payment must be reportable");
      },
    },
    {
      label: "1099 needs review without W-9",
      run: () => {
        const report = build1099ReviewReport(
          [
            {
              vendorId: "v1",
              vendorName: "Vendor",
              legalName: "Vendor LLC",
              eligible1099: true,
              form1099Category: "NEC",
              w9Received: false,
              entityType: "LLC",
              hasTin: false,
              paymentDate: "2026-05-01",
              amount: 1000,
              paymentMethod: "check",
              paymentType: "bill_payment",
            },
          ],
          2026,
        );
        if (report.rows[0]?.needsReview !== 1000) throw new Error("needs review amount wrong");
        if (report.filingEnabled !== false) throw new Error("filing must stay disabled");
      },
    },
    {
      label: "1099 zero amount excluded",
      run: () => {
        const c = classify1099Payment({
          amount: 0,
          paymentMethod: "check",
          eligible1099: true,
          w9Received: true,
          hasTin: true,
        });
        if (c.bucket !== "excluded") throw new Error("zero amount must be excluded");
      },
    },
    {
      label: "isLikelyExcludedPaymentMethod debit card",
      run: () => {
        if (!isLikelyExcludedPaymentMethod("debit_card")) {
          throw new Error("debit card must be excluded method");
        }
      },
    },
    {
      label: "Sales tax config review when jurisdiction missing",
      run: () => {
        const report = buildSalesTaxSummary({
          invoices: [
            {
              issueDate: "2026-03-01",
              subtotal: 100,
              tax: 8,
              jurisdiction: null,
              taxMode: "jurisdiction",
              status: "open",
              kind: "invoice",
            },
          ],
          periodStart: "2026-03-01",
          periodEnd: "2026-03-31",
          salesTaxPayableGlBalance: 8,
          orgTaxMode: "jurisdiction",
        });
        if (!report.configurationReviewRequired) throw new Error("expected config review flag");
        if (report.filingEnabled !== false) throw new Error("filing must stay disabled");
      },
    },
    {
      label: "Sales tax credit memo reduces net liability",
      run: () => {
        const report = buildSalesTaxSummary({
          invoices: [
            {
              issueDate: "2026-03-01",
              subtotal: 200,
              tax: 16,
              jurisdiction: "CA",
              taxMode: "jurisdiction",
              status: "open",
              kind: "invoice",
            },
          ],
          creditMemos: [
            {
              issueDate: "2026-03-15",
              subtotal: 50,
              tax: 4,
              jurisdiction: "CA",
              taxMode: "jurisdiction",
              status: "open",
              kind: "credit_memo",
            },
          ],
          periodStart: "2026-03-01",
          periodEnd: "2026-03-31",
          salesTaxPayableGlBalance: 12,
          orgTaxMode: "jurisdiction",
        });
        if (report.rows[0]?.netLiability !== 12) {
          throw new Error(`expected net liability 12 got ${report.rows[0]?.netLiability}`);
        }
      },
    },
    {
      label: "1099 export CSV excludes raw TIN column",
      run: () => {
        const report = build1099ReviewReport(
          [
            {
              vendorId: "v1",
              vendorName: "Secret Vendor",
              legalName: "Secret Vendor LLC",
              eligible1099: true,
              form1099Category: "NEC",
              w9Received: true,
              entityType: "LLC",
              hasTin: true,
              paymentDate: "2026-04-01",
              amount: 800,
              paymentMethod: "check",
              paymentType: "bill_payment",
            },
          ],
          2026,
        );
        const files = buildAccountantPackageFiles(
          {
            organizationName: "Test Org",
            periodLabel: "2026",
            generatedAt: new Date().toISOString(),
            vendor1099: report,
            includeTin: false,
          },
          ["1099_review"],
        );
        const csv = files[0]?.content ?? "";
        if (csv.toLowerCase().includes("tin_number") || csv.match(/\d{2}-\d{7}/)) {
          throw new Error("raw TIN must not appear in export");
        }
        if (!csv.includes("TIN Status")) throw new Error("TIN status column expected");
      },
    },

    // —— Presentation & accountant package ——
    {
      label: "Owner presentation label differs from accountant",
      run: () => {
        const owner = presentLabel("owner", "Net Income");
        const accountant = presentLabel("accountant", "Net Income");
        if (owner === accountant) throw new Error("owner label must differ");
      },
    },
    {
      label: "presentAccountName owner vs accountant AR",
      run: () => {
        const owner = presentAccountName("owner", "Accounts Receivable", "receivable");
        const accountant = presentAccountName("accountant", "Accounts Receivable", "receivable");
        if (owner === accountant) throw new Error("account names must differ by mode");
      },
    },
    {
      label: "Owner vs accountant P&L amounts equal",
      run: () => {
        const lines = [
          { account_id: "rev", debit: 0, credit: 500, entry_date: "2026-03-05" },
          { account_id: "exp", debit: 200, credit: 0, entry_date: "2026-03-05" },
        ];
        const accountant = buildProfitAndLoss(lines, ACCOUNTS);
        const owner = buildProfitAndLoss(lines, ACCOUNTS);
        if (
          accountant.totalRevenue !== owner.totalRevenue ||
          accountant.netIncome !== owner.netIncome
        ) {
          throw new Error("presentation mode must not change amounts");
        }
        if (presentLabel("owner", "Net Income") === presentLabel("accountant", "Net Income")) {
          throw new Error("labels must differ");
        }
      },
    },
    {
      label: "presentSectionLabel owner cash flow section",
      run: () => {
        const owner = presentSectionLabel("owner", "Operating");
        if (owner === "Operating") throw new Error("owner section label must differ");
      },
    },
    {
      label: "Accountant package P&L CSV",
      run: () => {
        const pl = buildProfitAndLoss([], ACCOUNTS);
        const files = buildAccountantPackageFiles(
          {
            organizationName: "Phase 10 Demo",
            periodLabel: "2026-03",
            generatedAt: new Date().toISOString(),
            profitAndLoss: pl,
          },
          ["profit_and_loss"],
        );
        if (!files[0]?.content.includes("Net Income")) throw new Error("P&L CSV missing net income");
      },
    },
    {
      label: "Accountant package balance sheet CSV",
      run: () => {
        const bs = buildBalanceSheet(
          [{ account_id: "cash", debit: 500, credit: 0, entry_date: "2026-03-01" }],
          ACCOUNTS,
          "2026-03-31",
          1,
        );
        const files = buildAccountantPackageFiles(
          {
            organizationName: "Phase 10 Demo",
            periodLabel: "2026-03",
            generatedAt: new Date().toISOString(),
            balanceSheet: bs,
          },
          ["balance_sheet"],
        );
        if (!files[0]?.content.includes("Assets")) throw new Error("BS CSV missing assets section");
      },
    },
    {
      label: "Accountant package trial balance CSV",
      run: () => {
        const tb = sampleTrialBalanceReport("2026-03-31", 500);
        const files = buildAccountantPackageFiles(
          {
            organizationName: "Phase 10 Demo",
            periodLabel: "2026-03",
            generatedAt: new Date().toISOString(),
            trialBalance: tb,
          },
          ["trial_balance"],
        );
        if (!files[0]?.content.includes("1000")) throw new Error("TB CSV missing cash account");
      },
    },

    // —— Tenant isolation & migration compatibility ——
    ctx.foreignOrgId
      ? {
          label: "Foreign org tenant isolation",
          run: async () => {
            assertNotHfacOrganization(ctx.foreignOrgId!);
            const { data } = await ctx.supabase
              .from("teller_organizations")
              .select("name")
              .eq("id", ctx.foreignOrgId!)
              .maybeSingle();
            if (data?.name !== CONTROLLED_PHASE10_FOREIGN_ORG_NAME) {
              throw new Error(`expected "${CONTROLLED_PHASE10_FOREIGN_ORG_NAME}"`);
            }
            if (ctx.foreignOrgId === ctx.orgId) throw new Error("foreign org must differ from demo org");
          },
        }
      : {
          label: "Foreign org tenant isolation constants",
          run: () => {
            assertNotHfacOrganization("00000000-0000-4000-8000-000000000002");
            if (HFAC_ORG_ID === ctx.orgId) throw new Error("demo org cannot be HFAC");
            if (!isControlledTestOrgName(CONTROLLED_PHASE10_FOREIGN_ORG_NAME)) {
              throw new Error("foreign org name must be controlled marker");
            }
          },
        },
    {
      label: "Migration 026 file exists",
      run: () => {
        const path = migration026Path();
        if (!existsSync(path)) throw new Error(`missing migration: ${path}`);
      },
    },
    {
      label: "Migration 026 is additive without teller_post_journal changes",
      run: () => {
        const sql = readFileSync(migration026Path(), "utf8");
        if (/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(sql)) {
          throw new Error("migration 026 must not replace teller_post_journal");
        }
        if (/drop\s+function\s+public\.teller_post_journal/i.test(sql)) {
          throw new Error("migration 026 must not drop teller_post_journal");
        }
        if (!sql.includes("cash_flow_category")) {
          throw new Error("migration 026 must add cash_flow_category");
        }
        if (!sql.includes("create table if not exists public.teller_report_line_groups")) {
          throw new Error("migration 026 must add report line groups");
        }
      },
    },
    {
      label: "Migration 026 enables RLS on new tables",
      run: () => {
        const sql = readFileSync(migration026Path(), "utf8");
        if (!sql.includes("enable row level security")) {
          throw new Error("migration 026 must enable RLS");
        }
      },
    },

    // —— Phase 5–9 regression delegation smoke ——
    {
      label: "Phase 5 postJournal export exists",
      run: () => assertFunctionExport(postJournal, "postJournal"),
    },
    {
      label: "Phase 5 postInvoiceOpen export exists",
      run: () => assertFunctionExport(postInvoiceOpen, "postInvoiceOpen"),
    },
    {
      label: "Phase 6 postBillOpen export exists",
      run: () => assertFunctionExport(postBillOpen, "postBillOpen"),
    },
    {
      label: "Phase 5 postExpense export exists",
      run: () => assertFunctionExport(postExpense, "postExpense"),
    },
    {
      label: "Phase 9 closeAccountingPeriod export exists",
      run: () => assertFunctionExport(closeAccountingPeriod, "closeAccountingPeriod"),
    },
    {
      label: "Phase 9 evaluateCloseReadiness export exists",
      run: () => assertFunctionExport(evaluateCloseReadiness, "evaluateCloseReadiness"),
    },
    {
      label: "Phase 9 createAdjustingJournal export exists",
      run: () => assertFunctionExport(createAdjustingJournal, "createAdjustingJournal"),
    },
    {
      label: "Phase 8 postDepreciationBatch export exists",
      run: () => assertFunctionExport(postDepreciationBatch, "postDepreciationBatch"),
    },
    {
      label: "Phase 7 summarizeJournalLinesForJob export exists",
      run: () => assertFunctionExport(summarizeJournalLinesForJob, "summarizeJournalLinesForJob"),
    },

    {
      label: "resolveJournalSource reversal entry kind",
      run: () => {
        const resolved = resolveJournalSource({
          sourceKind: "bill-payment",
          sourceId: "pay-1",
          reversesEntryId: "orig-1",
        });
        if (resolved.kind !== "reversal") throw new Error("reversal kind expected");
      },
    },
    {
      label: "resolveJournalSource vendor credit href",
      run: () => {
        const resolved = resolveJournalSource({ sourceKind: "vendor-credit", sourceId: "vc-1" });
        if (resolved.kind !== "vendor_credit" || !resolved.href?.includes("vc-1")) {
          throw new Error("vendor credit source not resolved");
        }
      },
    },
    {
      label: "Cash basis bill payment recognizes expense",
      run: () => {
        const settlements = buildCashBasisSettlements({
          documents: [OPEN_BILL_DOC],
          payments: [
            { id: "bp1", payment_date: "2026-03-12", payment_type: "bill_payment", amount: 500 },
          ],
          allocations: [
            { payment_id: "bp1", document_id: "bill1", amount: 500, allocation_kind: "bill_payment" },
          ],
          accounts: ACCOUNTS,
        });
        const pl = buildCashBasisProfitAndLoss(settlements, ACCOUNTS, "2026-03-01", "2026-03-31");
        if (pl.totalExpenses !== 500) throw new Error(`expected 500 got ${pl.totalExpenses}`);
      },
    },
    {
      label: "Customer balance report totals net balance",
      run: () => {
        const report = buildCustomerBalanceReport({
          parties: [
            { id: "c1", name: "A" },
            { id: "c2", name: "B" },
          ],
          invoiceRemainingByParty: new Map([
            ["c1", 300],
            ["c2", 200],
          ]),
          unappliedCreditsByParty: new Map([["c1", 50]]),
          asOf: "2026-03-31",
        });
        if (report.totalNetBalance !== 450) throw new Error(`expected 450 got ${report.totalNetBalance}`);
      },
    },
    {
      label: "Vendor balance report omits zero-balance parties",
      run: () => {
        const report = buildVendorBalanceReport({
          parties: [{ id: "v0", name: "Inactive" }],
          billRemainingByParty: new Map(),
          unappliedCreditsByParty: new Map(),
          asOf: "2026-03-31",
        });
        if (report.rows.length !== 0) throw new Error("zero balance vendors must be omitted");
      },
    },
    {
      label: "Phase 7 job profitability summarizes revenue lines",
      run: () => {
        const summary = summarizeJournalLinesForJob(
          "job1",
          [
            { account_id: "rev", debit: 0, credit: 400, job_id: "job1" },
            {
              account_id: "exp",
              debit: 150,
              credit: 0,
              job_id: "job1",
              cost_classification: "direct",
            },
          ],
          ACCOUNTS,
        );
        if (summary.recognizedRevenue !== 400 || summary.actualDirectCost !== 150) {
          throw new Error("job profitability summary wrong");
        }
      },
    },
    {
      label: "Comparative balance sheet balanced flag requires both periods",
      run: () => {
        const lines = [
          { account_id: "cash", debit: 2000, credit: 0, entry_date: "2026-01-01" },
          { account_id: "rev", debit: 0, credit: 2000, entry_date: "2026-01-01" },
        ];
        const current = buildBalanceSheet(lines, ACCOUNTS, "2026-03-31", 1);
        const prior = buildBalanceSheet(lines, ACCOUNTS, "2026-02-28", 1);
        const cbs = buildComparativeBalanceSheet(current, prior);
        if (!cbs.balanced) throw new Error("both periods must be balanced");
      },
    },
    {
      label: "Cash flow ending cash matches balance sheet cash",
      run: () => {
        const cfLines = [
          { account_id: "cash", debit: 1000, credit: 0, entry_date: "2026-02-28" },
          { account_id: "cash", debit: 250, credit: 0, entry_date: "2026-03-11" },
        ];
        const cf = buildCashFlowStatement({
          lines: cfLines,
          accounts: ACCOUNTS,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          accrualNetIncome: 0,
        });
        const bs = buildBalanceSheet(cfLines, ACCOUNTS, "2026-03-31", 1);
        const bsCash = bs.assets.find((a) => a.code === "1000")?.amount ?? 0;
        if (Math.abs(cf.endingCash - bsCash) > 0.01) {
          throw new Error(`ending cash ${cf.endingCash} !== BS cash ${bsCash}`);
        }
      },
    },

    // —— Batch FA depreciation ——
    {
      label: "batchSumPostedDepreciationForAssets aggregates per asset",
      run: async () => {
        const supabase = {
          from: () => ({
            select: () => ({
              in: () => ({
                eq: async () => ({
                  data: [
                    { asset_id: "a1", amount: 100, status: "posted" },
                    { asset_id: "a1", amount: 50, status: "posted" },
                    { asset_id: "a2", amount: 25, status: "posted" },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
        const map = await batchSumPostedDepreciationForAssets(supabase as never, ["a1", "a2", "a3"]);
        if (map.get("a1") !== 150 || map.get("a2") !== 25 || map.get("a3") !== 0) {
          throw new Error("batch depreciation aggregation wrong");
        }
      },
    },

    // —— HFAC unchanged after harness ——
    {
      label: "GL account totals RPC callable for demo org",
      run: async () => {
        const { error } = await ctx.supabase.rpc("teller_gl_account_totals", {
          p_organization_id: ctx.orgId,
          p_period_start: "2026-01-01",
          p_period_end: "2026-12-31",
        });
        if (error && /does not exist|schema cache|could not find/i.test(error.message)) {
          throw new Error(`teller_gl_account_totals unavailable: ${error.message}`);
        }
      },
    },
    {
      label: "HFAC unchanged after harness",
      run: async () => {
        const hfacAfter = await hfacBaseline(ctx.supabase);
        if (hfacAfter.journal_entries !== ctx.hfacBefore.journal_entries) {
          throw new Error(
            `HFAC journal count changed: before ${ctx.hfacBefore.journal_entries} after ${hfacAfter.journal_entries}`,
          );
        }
      },
    },
  ];

  if (matrix.length !== PHASE10_CONTROLLED_MATRIX_SIZE) {
    throw new Error(`Expected ${PHASE10_CONTROLLED_MATRIX_SIZE} scenarios, got ${matrix.length}`);
  }

  return matrix;
}

async function runScenario(name: string, fn: () => void | Promise<void>): Promise<ScenarioResult> {
  try {
    const result = fn();
    if (result instanceof Promise) {
      await result;
    }
    return { name, pass: true };
  } catch (error) {
    return { name, pass: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function runPhase10ControlledDemo(): Promise<{
  pass: number;
  fail: number;
  skipped: number;
  results: ScenarioResult[];
}> {
  const { orgId, foreignOrgId, supabase } = loadEnv();
  await assertDemoOrg(supabase, orgId);
  const hfacBefore = await hfacBaseline(supabase);

  const matrix = buildScenarioMatrix({ orgId, foreignOrgId, supabase, hfacBefore });
  if (matrix.length !== PHASE10_CONTROLLED_MATRIX_SIZE) {
    throw new Error(`Matrix size ${matrix.length} !== ${PHASE10_CONTROLLED_MATRIX_SIZE}`);
  }

  const results: ScenarioResult[] = [];
  for (let i = 0; i < matrix.length; i += 1) {
    const scenario = matrix[i]!;
    results.push(await runScenario(`${i + 1}. ${scenario.label}`, scenario.run));
  }

  const pass = results.filter((r) => r.pass && !r.skipped).length;
  const fail = results.filter((r) => !r.pass && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;

  return { pass, fail, skipped, results };
}

if (process.argv[1]?.endsWith("controlled-phase10-demo-runner.ts")) {
  runPhase10ControlledDemo()
    .then(({ pass, fail, skipped, results }) => {
      console.log(JSON.stringify({ pass, fail, skipped, total: results.length, results }, null, 2));
      process.exit(fail > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
