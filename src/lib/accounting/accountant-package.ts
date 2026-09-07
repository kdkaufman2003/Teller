import { rowsToCsv } from "./exports";
import type { AgingReport } from "./aging-service";
import type { ComparativeBalanceSheet, ComparativeProfitAndLoss } from "./comparative-reports";
import type { CashFlowStatement } from "./cash-flow-report";
import type { GlReportEntry } from "./gl-report";
import type { ProfitAndLoss } from "./reports";
import type { BalanceSheet } from "./financial-reports";
import type { TrialBalanceReport } from "./trial-balance";
import type { Vendor1099ReviewReport } from "./tax-1099-review";
import type { SalesTaxSummaryReport } from "./sales-tax-summary";

export type AccountantPackageSection =
  | "profit_and_loss"
  | "balance_sheet"
  | "trial_balance"
  | "general_ledger"
  | "ar_aging"
  | "ap_aging"
  | "bank_reconciliation_summary"
  | "fixed_asset_register"
  | "depreciation_schedule"
  | "1099_review"
  | "sales_tax_summary"
  | "owner_contributions_distributions";

export type AccountantPackageInput = {
  organizationName: string;
  periodLabel: string;
  generatedAt: string;
  profitAndLoss?: ProfitAndLoss | ComparativeProfitAndLoss;
  balanceSheet?: BalanceSheet | ComparativeBalanceSheet;
  trialBalance?: TrialBalanceReport;
  generalLedger?: GlReportEntry[];
  arAging?: AgingReport;
  apAging?: AgingReport;
  cashFlow?: CashFlowStatement;
  vendor1099?: Vendor1099ReviewReport;
  salesTax?: SalesTaxSummaryReport;
  bankReconciliationSummary?: string;
  fixedAssetRegister?: string;
  depreciationSchedule?: string;
  ownerContributionsDistributions?: string;
  includeTin?: boolean;
};

export type AccountantPackageFile = {
  filename: string;
  content: string;
  mimeType: string;
};

const DEFAULT_SECTIONS: AccountantPackageSection[] = [
  "profit_and_loss",
  "balance_sheet",
  "trial_balance",
  "general_ledger",
  "ar_aging",
  "ap_aging",
  "bank_reconciliation_summary",
  "fixed_asset_register",
  "depreciation_schedule",
  "1099_review",
  "sales_tax_summary",
  "owner_contributions_distributions",
];

export function buildAccountantPackageFiles(
  input: AccountantPackageInput,
  sections: AccountantPackageSection[] = DEFAULT_SECTIONS,
): AccountantPackageFile[] {
  const files: AccountantPackageFile[] = [];
  const prefix = sanitizeFilename(input.organizationName);

  if (sections.includes("profit_and_loss") && input.profitAndLoss) {
    files.push({
      filename: `${prefix}-profit-and-loss.csv`,
      content: profitAndLossToCsv(input.profitAndLoss),
      mimeType: "text/csv",
    });
  }

  if (sections.includes("balance_sheet") && input.balanceSheet) {
    files.push({
      filename: `${prefix}-balance-sheet.csv`,
      content: balanceSheetToCsv(input.balanceSheet),
      mimeType: "text/csv",
    });
  }

  if (sections.includes("trial_balance") && input.trialBalance) {
    files.push({
      filename: `${prefix}-trial-balance.csv`,
      content: trialBalanceToCsv(input.trialBalance),
      mimeType: "text/csv",
    });
  }

  if (sections.includes("general_ledger") && input.generalLedger) {
    files.push({
      filename: `${prefix}-general-ledger.csv`,
      content: generalLedgerToCsv(input.generalLedger),
      mimeType: "text/csv",
    });
  }

  if (sections.includes("ar_aging") && input.arAging) {
    files.push({
      filename: `${prefix}-ar-aging.csv`,
      content: agingToCsv("AR Aging", input.arAging),
      mimeType: "text/csv",
    });
  }

  if (sections.includes("ap_aging") && input.apAging) {
    files.push({
      filename: `${prefix}-ap-aging.csv`,
      content: agingToCsv("AP Aging", input.apAging),
      mimeType: "text/csv",
    });
  }

  if (sections.includes("1099_review") && input.vendor1099) {
    files.push({
      filename: `${prefix}-1099-review.csv`,
      content: vendor1099ToCsv(input.vendor1099, Boolean(input.includeTin)),
      mimeType: "text/csv",
    });
  }

  if (sections.includes("sales_tax_summary") && input.salesTax) {
    files.push({
      filename: `${prefix}-sales-tax-summary.csv`,
      content: salesTaxToCsv(input.salesTax),
      mimeType: "text/csv",
    });
  }

  if (sections.includes("bank_reconciliation_summary") && input.bankReconciliationSummary) {
    files.push({
      filename: `${prefix}-bank-reconciliation-summary.csv`,
      content: input.bankReconciliationSummary,
      mimeType: "text/csv",
    });
  }

  if (sections.includes("fixed_asset_register") && input.fixedAssetRegister) {
    files.push({
      filename: `${prefix}-fixed-asset-register.csv`,
      content: input.fixedAssetRegister,
      mimeType: "text/csv",
    });
  }

  if (sections.includes("depreciation_schedule") && input.depreciationSchedule) {
    files.push({
      filename: `${prefix}-depreciation-schedule.csv`,
      content: input.depreciationSchedule,
      mimeType: "text/csv",
    });
  }

  if (
    sections.includes("owner_contributions_distributions") &&
    input.ownerContributionsDistributions
  ) {
    files.push({
      filename: `${prefix}-owner-contributions-distributions.csv`,
      content: input.ownerContributionsDistributions,
      mimeType: "text/csv",
    });
  }

  return files;
}

function sanitizeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "teller";
}

function profitAndLossToCsv(pl: ProfitAndLoss | ComparativeProfitAndLoss): string {
  if ("totals" in pl && "netIncome" in pl.totals && "currentAmount" in pl.totals.netIncome) {
    const cpl = pl as ComparativeProfitAndLoss;
    const rows = [
      ...cpl.revenue.map((r) => ({
        section: "Revenue",
        code: r.code,
        account: r.name,
        current: r.currentAmount,
        comparison: r.comparisonAmount,
        variance: r.varianceAmount,
        variance_pct: r.variancePercent ?? "",
      })),
      ...cpl.cogs.map((r) => ({
        section: "COGS",
        code: r.code,
        account: r.name,
        current: r.currentAmount,
        comparison: r.comparisonAmount,
        variance: r.varianceAmount,
        variance_pct: r.variancePercent ?? "",
      })),
      ...cpl.expenses.map((r) => ({
        section: "Expense",
        code: r.code,
        account: r.name,
        current: r.currentAmount,
        comparison: r.comparisonAmount,
        variance: r.varianceAmount,
        variance_pct: r.variancePercent ?? "",
      })),
    ];
    return rowsToCsv(rows, [
      { key: "section", header: "Section" },
      { key: "code", header: "Code" },
      { key: "account", header: "Account" },
      { key: "current", header: "Current" },
      { key: "comparison", header: "Comparison" },
      { key: "variance", header: "Variance" },
      { key: "variance_pct", header: "Variance %" },
    ]);
  }
  const apl = pl as ProfitAndLoss;
  const rows = [
    ...apl.revenue.map((r) => ({ section: "Revenue", code: r.code, account: r.name, amount: r.amount })),
    ...apl.cogs.map((r) => ({ section: "COGS", code: r.code, account: r.name, amount: r.amount })),
    ...apl.expenses.map((r) => ({ section: "Expense", code: r.code, account: r.name, amount: r.amount })),
    { section: "", code: "", account: "Net Income", amount: apl.netIncome },
  ];
  return rowsToCsv(rows, [
    { key: "section", header: "Section" },
    { key: "code", header: "Code" },
    { key: "account", header: "Account" },
    { key: "amount", header: "Amount" },
  ]);
}

function balanceSheetToCsv(bs: BalanceSheet | ComparativeBalanceSheet): string {
  if ("totals" in bs && "totalAssets" in bs.totals && "currentAmount" in bs.totals.totalAssets) {
    const cbs = bs as ComparativeBalanceSheet;
    const rows = [
      ...cbs.assets.map((r) => ({
        section: "Assets",
        code: r.code,
        account: r.name,
        current: r.currentAmount,
        comparison: r.comparisonAmount,
        variance: r.varianceAmount,
      })),
      ...cbs.liabilities.map((r) => ({
        section: "Liabilities",
        code: r.code,
        account: r.name,
        current: r.currentAmount,
        comparison: r.comparisonAmount,
        variance: r.varianceAmount,
      })),
      ...cbs.equity.map((r) => ({
        section: "Equity",
        code: r.code,
        account: r.name,
        current: r.currentAmount,
        comparison: r.comparisonAmount,
        variance: r.varianceAmount,
      })),
    ];
    return rowsToCsv(rows, [
      { key: "section", header: "Section" },
      { key: "code", header: "Code" },
      { key: "account", header: "Account" },
      { key: "current", header: "Current" },
      { key: "comparison", header: "Comparison" },
      { key: "variance", header: "Variance" },
    ]);
  }
  const abs = bs as BalanceSheet;
  const rows = [
    ...abs.assets.map((r) => ({ section: "Assets", code: r.code, account: r.name, amount: r.amount })),
    ...abs.liabilities.map((r) => ({ section: "Liabilities", code: r.code, account: r.name, amount: r.amount })),
    ...abs.equity.map((r) => ({ section: "Equity", code: r.code, account: r.name, amount: r.amount })),
  ];
  return rowsToCsv(rows, [
    { key: "section", header: "Section" },
    { key: "code", header: "Code" },
    { key: "account", header: "Account" },
    { key: "amount", header: "Amount" },
  ]);
}

function trialBalanceToCsv(tb: TrialBalanceReport): string {
  return rowsToCsv(
    tb.rows.map((r) => ({
      code: r.code,
      account: r.name,
      opening_debit: r.openingDebit,
      opening_credit: r.openingCredit,
      period_debit: r.periodDebit,
      period_credit: r.periodCredit,
      adjusted_debit: r.adjustedDebit,
      adjusted_credit: r.adjustedCredit,
    })),
    [
      { key: "code", header: "Code" },
      { key: "account", header: "Account" },
      { key: "opening_debit", header: "Opening Debit" },
      { key: "opening_credit", header: "Opening Credit" },
      { key: "period_debit", header: "Period Debit" },
      { key: "period_credit", header: "Period Credit" },
      { key: "adjusted_debit", header: "Adjusted Debit" },
      { key: "adjusted_credit", header: "Adjusted Credit" },
    ],
  );
}

function generalLedgerToCsv(entries: GlReportEntry[]): string {
  const rows = [];
  for (const entry of entries) {
    for (const line of entry.lines) {
      rows.push({
        date: entry.entryDate,
        entry_id: entry.id,
        memo: entry.memo ?? "",
        source_kind: entry.sourceKind ?? "",
        source_id: entry.sourceId ?? "",
        account_code: line.accountCode,
        account: line.accountName,
        debit: line.debit,
        credit: line.credit,
        line_memo: line.memo ?? "",
      });
    }
  }
  return rowsToCsv(rows, [
    { key: "date", header: "Date" },
    { key: "entry_id", header: "Entry ID" },
    { key: "memo", header: "Memo" },
    { key: "source_kind", header: "Source Kind" },
    { key: "source_id", header: "Source ID" },
    { key: "account_code", header: "Account Code" },
    { key: "account", header: "Account" },
    { key: "debit", header: "Debit" },
    { key: "credit", header: "Credit" },
    { key: "line_memo", header: "Line Memo" },
  ]);
}

function agingToCsv(title: string, report: AgingReport): string {
  return rowsToCsv(
    [
      { bucket: title, amount: report.total, count: "" },
      ...report.buckets.map((b) => ({ bucket: b.label, amount: b.amount, count: b.count })),
    ],
    [
      { key: "bucket", header: "Bucket" },
      { key: "amount", header: "Amount" },
      { key: "count", header: "Count" },
    ],
  );
}

function vendor1099ToCsv(report: Vendor1099ReviewReport, includeTin: boolean): string {
  void includeTin;
  return rowsToCsv(
    report.rows.map((r) => ({
      vendor: r.vendorName,
      legal_name: r.legalName,
      eligible: r.eligible1099 ? "yes" : "no",
      w9: r.w9Received ? "yes" : "no",
      tin_status: r.tinStatus,
      likely_reportable: r.likelyReportable,
      excluded: r.excluded,
      needs_review: r.needsReview,
      total_payments: r.totalPayments,
      review_reasons: r.reviewReasons.join("; "),
    })),
    [
      { key: "vendor", header: "Vendor" },
      { key: "legal_name", header: "Legal Name" },
      { key: "eligible", header: "Eligible" },
      { key: "w9", header: "W-9" },
      { key: "tin_status", header: "TIN Status" },
      { key: "likely_reportable", header: "Likely Reportable" },
      { key: "excluded", header: "Excluded" },
      { key: "needs_review", header: "Needs Review" },
      { key: "total_payments", header: "Total Payments" },
      { key: "review_reasons", header: "Review Reasons" },
    ],
  );
}

function salesTaxToCsv(report: SalesTaxSummaryReport): string {
  return rowsToCsv(
    report.rows.map((r) => ({
      jurisdiction: r.jurisdiction,
      taxable_sales: r.taxableSales,
      non_taxable_sales: r.nonTaxableSales,
      tax_collected: r.taxCollected,
      credits_refunds: r.creditsRefunds,
      net_liability: r.netLiability,
      config_review: r.configurationReviewRequired ? "yes" : "no",
    })),
    [
      { key: "jurisdiction", header: "Jurisdiction" },
      { key: "taxable_sales", header: "Taxable Sales" },
      { key: "non_taxable_sales", header: "Non-Taxable Sales" },
      { key: "tax_collected", header: "Tax Collected" },
      { key: "credits_refunds", header: "Credits/Refunds" },
      { key: "net_liability", header: "Net Liability" },
      { key: "config_review", header: "Config Review Required" },
    ],
  );
}
