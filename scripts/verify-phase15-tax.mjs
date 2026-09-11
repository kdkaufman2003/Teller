#!/usr/bin/env node
/** Static Phase 15 tax schema/code verification — no DB writes. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];

function assertSqlFile(relPath, requiredTokens, label) {
  const path = join(root, relPath);
  if (!existsSync(path)) {
    issues.push(`Missing SQL: ${relPath}`);
    return;
  }
  const sql = readFileSync(path, "utf8");
  for (const token of requiredTokens) {
    if (!sql.includes(token)) issues.push(`${label} missing: ${token}`);
  }
  if (/\binsert\s+into\s+public\.teller_journal_entries/i.test(sql)) {
    issues.push(`${label} must not insert journal entries`);
  }
  if (/\b(create|alter|drop|replace)\s+function\s+public\.teller_post_journal/i.test(sql)) {
    issues.push(`${label} must not modify teller_post_journal`);
  }
}

assertSqlFile(
  "supabase/migrations/038_phase15g_tax_authority_payments.sql",
  [
    "teller_tax_authority_payments",
    "teller_tax_authority_payment_allocations",
    "teller_tax_manual_adjustments",
    "tax_penalty_expense_account_id",
    "enable row level security",
  ],
  "038 migration",
);

assertSqlFile(
  "supabase/migrations/037_phase15f_tax_filing_periods.sql",
  [
    "teller_tax_filing_periods",
    "teller_tax_filing_period_snapshots",
    "teller_guard_tax_filing_period_org",
    "filing_frequency",
    "ready_for_review",
    "enable row level security",
  ],
  "037 migration",
);

assertSqlFile(
  "supabase/migrations/035_phase15_tax_accounting.sql",
  [
    "teller_tax_authorities",
    "teller_tax_rate_components",
    "teller_tax_settings",
    "teller_tax_registrations",
    "teller_tax_categories",
    "teller_taxability_rules",
    "teller_tax_exemptions",
    "teller_tax_transactions",
    "teller_tax_transaction_components",
    "teller_tax_determination_snapshots",
    "teller_tax_audit_events",
    "enable row level security",
    "teller_guard_posted_tax_transaction",
    "teller_guard_tax_determination_snapshot_immutable",
    "effective_from",
    "effective_to",
    "parent_jurisdiction_key",
  ],
  "035 migration",
);

const requiredFiles = [
  "src/lib/accounting/tax/types.ts",
  "src/lib/accounting/tax/jurisdiction.ts",
  "src/lib/accounting/tax/rates.ts",
  "src/lib/accounting/tax/taxability.ts",
  "src/lib/accounting/tax/calculation-contract.ts",
  "src/lib/accounting/tax/calculation/engine.ts",
  "src/lib/accounting/tax/calculation/reason-codes.ts",
  "src/lib/accounting/tax/calculation/snapshot.ts",
  "src/lib/accounting/tax/calculate-for-org.ts",
  "src/lib/accounting/tax/posting-contract.ts",
  "src/lib/accounting/tax/immutability.ts",
  "src/lib/accounting/tax/phase15a.test.ts",
  "src/lib/accounting/tax/phase15b.test.ts",
  "src/lib/accounting/tax/phase15c.test.ts",
  "src/lib/accounting/tax/phase15d.test.ts",
  "src/lib/accounting/tax/phase15e.test.ts",
  "src/lib/accounting/tax/phase15f.test.ts",
  "src/lib/accounting/tax/phase15g.test.ts",
  "src/lib/accounting/tax/phase15h.test.ts",
  "src/lib/accounting/tax/state-packs/index.ts",
  "src/lib/accounting/tax/state-packs/activate.ts",
  "tax-rules/state-packs/MO-2026.1.json",
  "tax-rules/state-packs/KS-2026.1.json",
  "docs/tax/MO-TAX-SOURCES.md",
  "docs/tax/KS-TAX-SOURCES.md",
  "src/lib/accounting/tax/payments/post-payment.ts",
  "src/lib/accounting/tax/payments/adjustments.ts",
  "src/lib/accounting/tax/payments/bank-match.ts",
  "src/lib/accounting/tax/filing/reconcile.ts",
  "src/lib/accounting/tax/filing/period-generation.ts",
  "src/lib/accounting/tax/filing/rollforward.ts",
  "src/lib/accounting/tax/filing/readiness.ts",
  "src/lib/accounting/tax/filing/service.ts",
  "src/app/api/tax/filing-periods/route.ts",
  "src/components/TaxFilingPeriodsView.tsx",
  "src/lib/accounting/tax/purchase/compare-vendor-tax.ts",
  "src/lib/accounting/tax/purchase/use-tax-journal.ts",
  "src/lib/accounting/tax/posting/open-bill.ts",
  "src/lib/accounting/tax/posting/prepare-purchase.ts",
  "src/lib/accounting/tax/posting/persist-purchase-tax.ts",
  "src/lib/accounting/tax/posting/open-invoice.ts",
  "src/lib/accounting/tax/posting/persist-transactions.ts",
  "src/lib/accounting/tax/exemptions/resolver.ts",
  "src/app/api/settings/tax/route.ts",
  "src/app/api/tax/calculate/route.ts",
  "src/app/api/tax/exemptions/route.ts",
  "src/app/app/settings/tax/page.tsx",
];

for (const rel of requiredFiles) {
  if (!existsSync(join(root, rel))) issues.push(`Missing file: ${rel}`);
}

const postingContract = readFileSync(join(root, "src/lib/accounting/tax/posting-contract.ts"), "utf8");
if (/teller_post_journal|postJournal/i.test(postingContract)) {
  issues.push("posting-contract must not call teller_post_journal in 15A");
}

const calcDomain = [
  "src/lib/accounting/tax/calculation/engine.ts",
  "src/lib/accounting/tax/calculation/rules.ts",
  "src/lib/accounting/tax/calculation/rate-resolution.ts",
  "src/lib/accounting/tax/calculation/money.ts",
  "src/lib/accounting/tax/calculate-for-org.ts",
  "src/lib/accounting/tax/exemptions/resolver.ts",
  "src/lib/accounting/tax/exemptions/validity.ts",
  "src/lib/accounting/tax/exemptions/scope.ts",
  "src/lib/accounting/tax/exemptions/load.ts",
]
  .map((rel) => readFileSync(join(root, rel), "utf8"))
  .join("\n");

if (!/teller_tax_engine_v1/.test(calcDomain)) {
  issues.push("calculation engine must expose teller_tax_engine_v1 version");
}
if (!/TaxReviewReason|MISSING_TAX_LOCATION|AMBIGUOUS_TAX_RATE|AMBIGUOUS_EXEMPTION/.test(calcDomain)) {
  issues.push("calculation domain must define needs-review reason codes");
}
if (!/resolveCustomerExemption|isExemptionDateValid|jurisdictionScopeMatches/.test(calcDomain)) {
  issues.push("15C exemption resolver and validity checks must exist");
}
if (!/loadPartyTaxExemptions/.test(calcDomain)) {
  issues.push("calculator must load party exemptions via canonical loader");
}
if (!/toCents|taxFromBasisCents|fromCents/.test(calcDomain)) {
  issues.push("calculation domain must use exact-cent money helpers");
}
if (/teller_post_journal|postJournal|insert\s+into\s+.*teller_journal/i.test(calcDomain)) {
  issues.push("15B calculation domain must not post journals");
}
if (/fetch\s*\(|axios|avalara|taxjar|stripe\.com\/tax/i.test(calcDomain)) {
  issues.push("15B calculation domain must not call external tax providers");
}

const postingDomain = [
  "src/lib/accounting/tax/posting/open-invoice.ts",
  "src/lib/accounting/tax/posting/open-credit.ts",
  "src/lib/accounting/tax/posting/open-bill.ts",
  "src/lib/accounting/tax/posting/persist-transactions.ts",
  "src/lib/accounting/tax/posting/persist-purchase-tax.ts",
  "src/lib/accounting/tax/posting/prepare.ts",
  "src/lib/accounting/tax/posting/prepare-purchase.ts",
  "src/lib/accounting/tax/purchase/compare-vendor-tax.ts",
  "src/lib/accounting/tax/purchase/use-tax-journal.ts",
]
  .map((rel) => readFileSync(join(root, rel), "utf8"))
  .join("\n");

if (!/calculateTaxForOrganization|prepareDocumentTaxPosting/.test(postingDomain)) {
  issues.push("15D posting must use canonical calculator and prepare flow");
}
if (!/teller_tax_transactions|teller_tax_determination_snapshots/.test(postingDomain)) {
  issues.push("15D posting must persist tax subledger and snapshots");
}
if (!/salesTaxPayableAccountId|resolveSalesTaxPayableAccountId/.test(postingDomain)) {
  issues.push("15D posting must resolve configured tax liability account");
}
if (/teller_post_journal/.test(postingDomain)) {
  issues.push("15D posting module must not call teller_post_journal directly");
}
if (!/comparePurchaseTax|vendorTaxCharged|useTaxDue/.test(postingDomain)) {
  issues.push("15E purchase tax comparison and use-tax due calculation must exist");
}
if (!/use_tax_accrued|persistPostedPurchaseTaxBundle/.test(postingDomain)) {
  issues.push("15E must persist use tax accruals to tax subledger");
}
if (!/buildUseTaxJournalLines|resolveUseTaxExpenseAccountId/.test(postingDomain)) {
  issues.push("15E must build use-tax journal lines with configured accounts");
}
if (!/allocateVendorPurchaseTax|additionalJournalLines/.test(postingDomain + readFileSync(join(root, "src/lib/accounting/bills.ts"), "utf8"))) {
  issues.push("15E must preserve AP boundary — vendor tax separate from use tax");
}
if (!/recordPurchaseTaxReversalForDocument/.test(postingDomain + readFileSync(join(root, "src/lib/accounting/tax/posting/reverse-transactions.ts"), "utf8"))) {
  issues.push("15E must reuse append-only reversal architecture for purchase tax");
}

const filingDomain = [
  "src/lib/accounting/tax/filing/reconcile.ts",
  "src/lib/accounting/tax/filing/period-generation.ts",
  "src/lib/accounting/tax/filing/rollforward.ts",
  "src/lib/accounting/tax/filing/readiness.ts",
  "src/lib/accounting/tax/filing/service.ts",
]
  .map((rel) => readFileSync(join(root, rel), "utf8"))
  .join("\n");

if (!/reconcileTaxPeriod/.test(filingDomain)) {
  issues.push("15F must expose canonical reconcileTaxPeriod service");
}
if (!/generateFilingPeriodsForRegistration|generateTaxFilingPeriods/.test(filingDomain)) {
  issues.push("15F must generate registration-driven filing periods");
}
if (!/sales_tax|use_tax|aggregateRollforward/.test(filingDomain)) {
  issues.push("15F rollforward must include sales and use tax categories");
}
if (!/vendorTaxChargedDocument|vendor_tax_collected/.test(filingDomain)) {
  issues.push("15F rollforward must exclude vendor-charged purchase tax from liability");
}
if (!/subledgerToGlDifference|glRollforwardDifference/.test(filingDomain)) {
  issues.push("15F must reconcile tax subledger to GL tax payable");
}
if (!/GL_WITHOUT_TAX_SUBLEDGER|ORPHAN_TAX_SUBLEDGER|NEEDS_REVIEW/.test(filingDomain)) {
  issues.push("15F must define reconciliation exception codes");
}
if (!/evaluatePeriodReadiness|ready_for_review/.test(filingDomain)) {
  issues.push("15F must implement period readiness model");
}
if (!/isImmutableFilingPeriodStatus|filed/.test(filingDomain)) {
  issues.push("15F must preserve filed-period immutability");
}
if (/teller_post_journal|insert\s+into\s+.*teller_journal/i.test(filingDomain)) {
  issues.push("15F filing module must not create journal entries");
}

const paymentDomain = [
  "src/lib/accounting/tax/payments/post-payment.ts",
  "src/lib/accounting/tax/payments/adjustments.ts",
  "src/lib/accounting/tax/payments/bank-match.ts",
  "src/lib/accounting/tax/filing/rollforward.ts",
]
  .map((rel) => readFileSync(join(root, rel), "utf8"))
  .join("\n");

if (!/postAuthorityTaxPayment|reverseAuthorityTaxPayment/.test(paymentDomain)) {
  issues.push("15G tax authority payment service missing");
}
if (!/postTaxManualAdjustment/.test(paymentDomain)) {
  issues.push("15G manual tax adjustment service missing");
}
if (!/authorityPayments|case\s+["']authority_payment["']/.test(paymentDomain)) {
  issues.push("15G rollforward must reduce liability for authority payments");
}
if (!/penalty_amount|penaltyExpenseAccountId/.test(paymentDomain)) {
  issues.push("15G must separate penalty from base tax payable");
}
if (!/linkAuthorityTaxPaymentToBankTransaction/.test(paymentDomain)) {
  issues.push("15G bank match boundary missing");
}
if (!/idempotency_key|idempotencyKey/.test(paymentDomain)) {
  issues.push("15G payment idempotency missing");
}
if (/\bavalara\b|\btaxjar\b|\bach origination\b|\bwire origination\b/i.test(paymentDomain)) {
  issues.push("15G must not add automated government payment integrations");
}

const statePackDomain = [
  "src/lib/accounting/tax/state-packs/registry.ts",
  "src/lib/accounting/tax/state-packs/validate.ts",
  "src/lib/accounting/tax/state-packs/sourcing.ts",
  "src/lib/accounting/tax/state-packs/rate-policy.ts",
  "src/lib/accounting/tax/state-packs/activate.ts",
  "src/lib/accounting/tax/calculation/engine.ts",
  "tax-rules/state-packs/MO-2026.1.json",
  "tax-rules/state-packs/KS-2026.1.json",
]
  .map((rel) => readFileSync(join(root, rel), "utf8"))
  .join("\n");

if (!/MO-2026\.1|KS-2026\.1/.test(statePackDomain)) {
  issues.push("15H MO/KS state packs missing");
}
if (!/activateStateTaxPack|validateStateTaxPack/.test(statePackDomain)) {
  issues.push("15H state pack activation/validation missing");
}
if (!/origin_seller|destination/.test(statePackDomain)) {
  issues.push("15H sourcing models missing");
}
if (!/sourceCitation|sourceReferences|sourceReviewedAt/.test(statePackDomain)) {
  issues.push("15H source metadata missing");
}
if (!/UNKNOWN_LOCAL_JURISDICTION/.test(statePackDomain)) {
  issues.push("15H unknown local jurisdiction handling missing");
}
if (/nexus|you have nexus|required to register/i.test(statePackDomain)) {
  issues.push("15H must not automate nexus determination messaging");
}
if (/teller_post_journal|postJournal|insert\s+into\s+.*teller_journal/i.test(statePackDomain)) {
  issues.push("15H state packs must not create journals");
}
if (
  /authority_payment/.test(filingDomain) &&
  !/\.neq\(\s*["']transaction_type["']\s*,\s*["']authority_payment["']\)|case\s+["']authority_payment["']/.test(
    filingDomain,
  )
) {
  issues.push("15F must exclude authority payment from period liability");
}

const reportDomain = [
  "src/lib/accounting/tax/reports/index.ts",
  "src/lib/accounting/tax/reports/summary.ts",
  "src/lib/accounting/tax/reports/rollforward.ts",
  "src/lib/accounting/tax/reports/gl-reconciliation.ts",
  "src/lib/accounting/tax/reports/details.ts",
  "src/lib/accounting/tax/reports/payments-adjustments.ts",
  "src/lib/accounting/tax/reports/needs-review.ts",
  "src/lib/accounting/tax/reports/accountant-package.ts",
  "src/lib/accounting/tax/reports/csv.ts",
  "src/app/api/reports/tax/route.ts",
  "src/app/api/reports/tax/accountant-package/route.ts",
]
  .map((rel) => readFileSync(join(root, rel), "utf8"))
  .join("\n");

if (!/buildTaxSummaryReport|buildTaxSummaryFromTransactions/.test(reportDomain)) {
  issues.push("15I tax summary report missing");
}
if (!/buildTaxRollforwardReport|buildTaxRollforwardFromTransactions/.test(reportDomain)) {
  issues.push("15I liability rollforward report missing");
}
if (!/buildTaxGlReconciliationReport/.test(reportDomain)) {
  issues.push("15I GL reconciliation report missing");
}
if (!/buildSalesTaxDetailReport/.test(reportDomain)) {
  issues.push("15I sales tax detail report missing");
}
if (!/buildUseTaxDetailReport/.test(reportDomain)) {
  issues.push("15I use tax detail report missing");
}
if (!/buildExemptTaxDetailReport/.test(reportDomain)) {
  issues.push("15I exempt tax report missing");
}
if (!/buildNeedsReviewTaxReport/.test(reportDomain)) {
  issues.push("15I needs-review report missing");
}
if (!/buildTaxPaymentReport|buildTaxAdjustmentReport/.test(reportDomain)) {
  issues.push("15I payment/adjustment reporting missing");
}
if (!/buildAccountantTaxPackage|README\.txt/.test(reportDomain)) {
  issues.push("15I accountant package missing");
}
if (!/sanitizeTaxCsvCell|FORMULA_PREFIX/.test(reportDomain)) {
  issues.push("15I CSV formula injection protection missing");
}
if (!/requireBooks|organizationId/.test(reportDomain)) {
  issues.push("15I tenant-scoped report API missing");
}
if (/teller_post_journal|postJournal|insert\s+into\s+.*teller_journal/i.test(reportDomain)) {
  issues.push("15I tax reports must not create journals");
}
if (!/transaction_date|TAX_REPORT_DATE_BASIS/.test(reportDomain)) {
  issues.push("15I report date basis must be documented");
}
if (!/paginateRows|TRANSACTION_ID_BATCH_SIZE|JOURNAL_ENTRY_ID_BATCH_SIZE/.test(reportDomain)) {
  issues.push("15I large dataset batching/pagination missing");
}

const ownerDomain = [
  "src/lib/accounting/tax/owner/index.ts",
  "src/lib/accounting/tax/owner/summary.ts",
  "src/lib/accounting/tax/owner/attention.ts",
  "src/lib/accounting/tax/owner/next-period.ts",
  "src/app/api/tax/overview/route.ts",
  "src/components/TaxOverviewView.tsx",
]
  .map((rel) => readFileSync(join(root, rel), "utf8"))
  .join("\n");

if (!/getTaxOwnerSummary|aggregateTaxOwedFromPeriods/.test(ownerDomain)) {
  issues.push("15J owner summary service missing");
}
if (!/buildTaxPaymentReport|buildNeedsReviewTaxReport/.test(ownerDomain)) {
  issues.push("15J owner summary must use canonical report services");
}
if (!/selectNextFilingPeriod|buildTaxAttentionItems/.test(ownerDomain)) {
  issues.push("15J next period / attention integration missing");
}
if (!/presentationMode|accountantDetail/.test(ownerDomain)) {
  issues.push("15J owner/accountant mode separation missing");
}
if (!/requireBooks|organizationId/.test(ownerDomain)) {
  issues.push("15J overview API tenant scoping missing");
}
if (/teller_post_journal|postJournal|postAuthorityTaxPayment|insert\s+into\s+.*teller_journal/i.test(ownerDomain)) {
  issues.push("15J overview must be read-only");
}
if (!/filing_periods|loadTaxPeriodPaymentSummary|buildTaxPaymentReport/.test(ownerDomain)) {
  issues.push("15J tax owed/paid must use filing and payment truth");
}
if (!/OWNER_SUMMARY_MAX_PERIODS|OWNER_SUMMARY_PAYMENT_DETAIL_LIMIT/.test(ownerDomain)) {
  issues.push("15J bounded query limits missing");
}
if (!/dueDateConfigured|Not configured/.test(ownerDomain)) {
  issues.push("15J due date safety messaging missing");
}

// Phase 15K — final release-candidate static checks
const fullTaxDomain = [
  calcDomain,
  postingDomain,
  filingDomain,
  paymentDomain,
  statePackDomain,
  reportDomain,
  ownerDomain,
  readFileSync(join(root, "src/lib/accounting/tax/immutability.ts"), "utf8"),
  readFileSync(join(root, "src/lib/accounting/tax/tenant-isolation.ts"), "utf8"),
].join("\n");

if (!/calculateTaxForOrganization/.test(fullTaxDomain)) {
  issues.push("15K must expose single canonical calculateTaxForOrganization entry");
}
if (!/export function calculateTax/.test(readFileSync(join(root, "src/lib/accounting/tax/calculation/engine.ts"), "utf8"))) {
  issues.push("15K single tax determination engine (calculation/engine.ts) missing");
}
if (/fileTaxReturn|submitReturn|automatedRemittance|nexusDetermination|governmentPortal/i.test(fullTaxDomain)) {
  issues.push("15K must not include automated filing/nexus/remittance");
}
if (!/POSTED_TAX_HISTORY_IMMUTABLE|rejectCrossOrgReference|assertSameOrganization/.test(fullTaxDomain)) {
  issues.push("15K immutability and tenant isolation guards missing");
}
if (!/enable row level security/.test(readFileSync(join(root, "supabase/migrations/035_phase15_tax_accounting.sql"), "utf8"))) {
  issues.push("15K RLS missing on 035 tax tables");
}
if (!/teller_tax_authority_payments[\s\S]*enable row level security/.test(readFileSync(join(root, "supabase/migrations/038_phase15g_tax_authority_payments.sql"), "utf8"))) {
  issues.push("15K RLS missing on 038 payment tables");
}
if (!/15K_E2E_SALES_TAX_LIFECYCLE|15K_OWNER_DASHBOARD_FINAL/.test(readFileSync(join(root, "scripts/controlled-phase15-db-acceptance.ts"), "utf8"))) {
  issues.push("15K final E2E acceptance scenarios missing");
}
if (!existsSync(join(root, "docs/PHASE-15-RELEASE-NOTES.md"))) {
  issues.push("15K release notes missing");
}

for (const rel of [
  "src/lib/accounting/tax/phase15a.test.ts",
  "src/lib/accounting/tax/phase15b.test.ts",
  "src/lib/accounting/tax/phase15c.test.ts",
  "src/lib/accounting/tax/phase15d.test.ts",
  "src/lib/accounting/tax/phase15e.test.ts",
  "src/lib/accounting/tax/phase15f.test.ts",
  "src/lib/accounting/tax/phase15g.test.ts",
  "src/lib/accounting/tax/phase15h.test.ts",
  "src/lib/accounting/tax/phase15i.test.ts",
  "src/lib/accounting/tax/phase15j.test.ts",
]) {
  const content = readFileSync(join(root, rel), "utf8");
  if (/\.skip\(|\.todo\(|placeholder/i.test(content)) {
    issues.push(`${rel} contains placeholder/skip markers`);
  }
}

console.log(
  JSON.stringify(
    {
      PHASE15_TAX_VERIFY: issues.length === 0 ? "PASS" : "FAIL",
      issues,
      manualMigrationRequired: true,
      migrationFiles: [
        "supabase/migrations/035_phase15_tax_accounting.sql",
        "supabase/migrations/037_phase15f_tax_filing_periods.sql",
        "supabase/migrations/038_phase15g_tax_authority_payments.sql",
      ],
    },
    null,
    2,
  ),
);

process.exit(issues.length === 0 ? 0 : 1);
