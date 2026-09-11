import type { SupabaseClient } from "@supabase/supabase-js";
import { moneyCsv, taxRowsToCsv } from "./csv";
import type {
  AccountantTaxPackageFile,
  AccountantTaxPackageManifest,
  TaxReportFilters,
} from "./types";
import { TAX_REPORT_DATE_BASIS, TAX_REPORT_VERSION } from "./types";
import { buildTaxSummaryReport } from "./summary";
import { buildTaxRollforwardReport } from "./rollforward";
import { buildTaxGlReconciliationReport } from "./gl-reconciliation";
import { buildSalesTaxDetailReport, buildUseTaxDetailReport, buildExemptTaxDetailReport } from "./details";
import { buildTaxPaymentReport, buildTaxAdjustmentReport } from "./payments-adjustments";
import { buildNeedsReviewTaxReport } from "./needs-review";
import { buildJurisdictionSummaryReport, buildAuthoritySummaryReport } from "./jurisdiction-authority";
import { buildFilingPeriodTaxReport } from "./filing-period-report";
import { parseTaxReportPagination } from "./filters";

export async function buildAccountantTaxPackage(
  supabase: SupabaseClient,
  filters: TaxReportFilters,
  options?: { organizationName?: string | null },
): Promise<{ manifest: AccountantTaxPackageManifest; files: AccountantTaxPackageFile[] }> {
  const pagination = parseTaxReportPagination({ limit: "10000", offset: "0" });

  const [
    summary,
    rollforward,
    glReconciliation,
    salesDetail,
    useDetail,
    exemptDetail,
    payments,
    adjustments,
    exceptions,
    jurisdictions,
    authorities,
    filingPeriod,
  ] = await Promise.all([
    buildTaxSummaryReport(supabase, filters),
    filters.startDate && filters.endDate ? buildTaxRollforwardReport(supabase, filters) : Promise.resolve(null),
    buildTaxGlReconciliationReport(supabase, filters),
    buildSalesTaxDetailReport(supabase, filters, pagination),
    buildUseTaxDetailReport(supabase, filters, pagination),
    buildExemptTaxDetailReport(supabase, filters, pagination),
    buildTaxPaymentReport(supabase, filters, pagination),
    buildTaxAdjustmentReport(supabase, filters, pagination),
    buildNeedsReviewTaxReport(supabase, filters, pagination),
    buildJurisdictionSummaryReport(supabase, filters, pagination),
    buildAuthoritySummaryReport(supabase, filters, pagination),
    filters.filingPeriodId
      ? buildFilingPeriodTaxReport(supabase, filters.organizationId, filters.filingPeriodId)
      : Promise.resolve(null),
  ]);

  const { data: registrations } = await supabase
    .from("teller_tax_registrations")
    .select("id, jurisdiction_key, registration_number, metadata")
    .eq("organization_id", filters.organizationId)
    .eq("status", "active");

  const statePackVersions = [
    ...new Set(
      (registrations ?? [])
        .map((row) => (row.metadata as { statePackVersion?: string } | null)?.statePackVersion)
        .filter(Boolean) as string[],
    ),
  ];

  const { data: authoritiesData } = await supabase
    .from("teller_tax_registrations")
    .select("authority_id, teller_tax_authorities(name)")
    .eq("organization_id", filters.organizationId)
    .eq("status", "active");

  const files: AccountantTaxPackageFile[] = [
    {
      filename: "tax-summary.csv",
      content: taxRowsToCsv(
        [
          {
            taxableSales: moneyCsv(summary.taxableSales),
            exemptSales: moneyCsv(summary.exemptSales),
            nonTaxableSales: moneyCsv(summary.nonTaxableSales),
            salesTaxAccrued: moneyCsv(summary.salesTaxAccrued),
            useTaxAccrued: moneyCsv(summary.useTaxAccrued),
            salesTaxCredits: moneyCsv(summary.salesTaxCredits),
            taxAdjustments: moneyCsv(summary.taxAdjustments),
            authorityPayments: moneyCsv(summary.authorityPayments),
            netLiabilityChange: moneyCsv(summary.netLiabilityChange),
          },
        ],
        [
          { key: "taxableSales", header: "Taxable Sales" },
          { key: "exemptSales", header: "Exempt Sales" },
          { key: "nonTaxableSales", header: "Non-Taxable Sales" },
          { key: "salesTaxAccrued", header: "Sales Tax Accrued" },
          { key: "useTaxAccrued", header: "Use Tax Accrued" },
          { key: "salesTaxCredits", header: "Credits/Reversals" },
          { key: "taxAdjustments", header: "Adjustments" },
          { key: "authorityPayments", header: "Tax Payments" },
          { key: "netLiabilityChange", header: "Net Liability Change" },
        ],
      ),
    },
  ];

  if (rollforward) {
    files.push({
      filename: "liability-rollforward.csv",
      content: taxRowsToCsv(
        [
          {
            beginning: moneyCsv(rollforward.beginningLiability),
            sales: moneyCsv(rollforward.salesTaxAccrued),
            use: moneyCsv(rollforward.useTaxAccrued),
            credits: moneyCsv(rollforward.salesTaxCredits),
            adjustments: moneyCsv(rollforward.taxAdjustments),
            payments: moneyCsv(rollforward.authorityPayments),
            ending: moneyCsv(rollforward.endingOutstandingLiability),
          },
        ],
        [
          { key: "beginning", header: "Beginning Liability" },
          { key: "sales", header: "Sales Tax Accrued" },
          { key: "use", header: "Use Tax Accrued" },
          { key: "credits", header: "Credits/Reversals" },
          { key: "adjustments", header: "Adjustments" },
          { key: "payments", header: "Tax Payments" },
          { key: "ending", header: "Ending Outstanding Liability" },
        ],
      ),
    });
  }

  files.push({
    filename: "gl-reconciliation.csv",
    content: taxRowsToCsv(
      [
        {
          subledger: moneyCsv(glReconciliation.subledgerLiability),
          gl: moneyCsv(glReconciliation.glLiability),
          difference: moneyCsv(glReconciliation.difference),
          status: glReconciliation.status,
          exceptions: glReconciliation.exceptionCount,
        },
      ],
      [
        { key: "subledger", header: "Subledger Liability" },
        { key: "gl", header: "GL Liability" },
        { key: "difference", header: "Difference" },
        { key: "status", header: "Status" },
        { key: "exceptions", header: "Exception Count" },
      ],
    ),
  });

  files.push({
    filename: "sales-tax-detail.csv",
    content: taxRowsToCsv(
      salesDetail.rows.map((row) => ({
        date: row.transactionDate,
        document: row.documentNumber ?? row.documentId,
        customer: row.customerName,
        category: row.lineCategory,
        basis: moneyCsv(row.taxableBasis),
        tax: moneyCsv(row.taxAmount),
        jurisdiction: row.jurisdictionKey,
        status: row.determinationStatus,
        journal: row.journalEntryId,
      })),
      [
        { key: "date", header: "Date" },
        { key: "document", header: "Document" },
        { key: "customer", header: "Customer" },
        { key: "category", header: "Category" },
        { key: "basis", header: "Taxable Basis" },
        { key: "tax", header: "Tax Amount" },
        { key: "jurisdiction", header: "Jurisdiction" },
        { key: "status", header: "Status" },
        { key: "journal", header: "Journal Entry" },
      ],
    ),
  });

  files.push({
    filename: "use-tax-detail.csv",
    content: taxRowsToCsv(
      useDetail.rows.map((row) => ({
        date: row.transactionDate,
        document: row.documentNumber ?? row.documentId,
        vendor: row.vendorName,
        basis: moneyCsv(row.purchaseBasis),
        vendorTax: moneyCsv(row.vendorTaxCharged),
        useTax: moneyCsv(row.useTaxAccrued),
        jurisdiction: row.jurisdictionKey,
        status: row.determinationStatus,
      })),
      [
        { key: "date", header: "Date" },
        { key: "document", header: "Document" },
        { key: "vendor", header: "Vendor" },
        { key: "basis", header: "Purchase Basis" },
        { key: "vendorTax", header: "Vendor Tax Charged" },
        { key: "useTax", header: "Use Tax Accrued" },
        { key: "jurisdiction", header: "Jurisdiction" },
        { key: "status", header: "Status" },
      ],
    ),
  });

  files.push({
    filename: "tax-payments.csv",
    content: taxRowsToCsv(
      payments.rows.map((row) => ({
        date: row.paymentDate,
        authority: row.authorityName,
        amount: moneyCsv(row.paymentAmount),
        base: moneyCsv(row.baseTaxAmount),
        penalty: moneyCsv(row.penaltyAmount),
        interest: moneyCsv(row.interestAmount),
        reference: row.referenceNumber,
        journal: row.journalEntryId,
      })),
      [
        { key: "date", header: "Payment Date" },
        { key: "authority", header: "Authority" },
        { key: "amount", header: "Total Payment" },
        { key: "base", header: "Base Tax" },
        { key: "penalty", header: "Penalty" },
        { key: "interest", header: "Interest" },
        { key: "reference", header: "Reference" },
        { key: "journal", header: "Journal Entry" },
      ],
    ),
  });

  files.push({
    filename: "tax-adjustments.csv",
    content: taxRowsToCsv(
      adjustments.rows.map((row) => ({
        date: row.adjustmentDate,
        type: row.adjustmentType,
        reason: row.reason,
        amount: moneyCsv(row.amount),
        journal: row.journalEntryId,
      })),
      [
        { key: "date", header: "Date" },
        { key: "type", header: "Type" },
        { key: "reason", header: "Reason" },
        { key: "amount", header: "Amount" },
        { key: "journal", header: "Journal Entry" },
      ],
    ),
  });

  files.push({
    filename: "exempt-transactions.csv",
    content: taxRowsToCsv(
      exemptDetail.rows.map((row) => ({
        date: row.transactionDate,
        customer: row.customerName,
        basis: moneyCsv(row.exemptedBasis),
        certificate: row.certificateNumber,
        status: row.certificateStatusAtDetermination,
        jurisdiction: row.jurisdictionKey,
      })),
      [
        { key: "date", header: "Date" },
        { key: "customer", header: "Customer" },
        { key: "basis", header: "Exempted Basis" },
        { key: "certificate", header: "Certificate" },
        { key: "status", header: "Certificate Status At Determination" },
        { key: "jurisdiction", header: "Jurisdiction" },
      ],
    ),
  });

  files.push({
    filename: "needs-review.csv",
    content: taxRowsToCsv(
      exceptions.rows.map((row) => ({
        source: row.source,
        code: row.reasonCode,
        message: row.message,
        severity: row.severity,
        amount: row.amount != null ? moneyCsv(row.amount) : "",
      })),
      [
        { key: "source", header: "Source" },
        { key: "code", header: "Reason Code" },
        { key: "message", header: "Message" },
        { key: "severity", header: "Severity" },
        { key: "amount", header: "Amount" },
      ],
    ),
  });

  files.push({
    filename: "jurisdiction-summary.csv",
    content: taxRowsToCsv(
      jurisdictions.rows.map((row) => ({
        jurisdiction: row.jurisdictionKey,
        level: row.jurisdictionLevel,
        basis: moneyCsv(row.taxableBasis),
        accrued: moneyCsv(row.taxAccrued),
        net: moneyCsv(row.netLiability),
      })),
      [
        { key: "jurisdiction", header: "Jurisdiction" },
        { key: "level", header: "Level" },
        { key: "basis", header: "Taxable Basis" },
        { key: "accrued", header: "Tax Accrued" },
        { key: "net", header: "Net Liability" },
      ],
    ),
  });

  files.push({
    filename: "authority-summary.csv",
    content: taxRowsToCsv(
      authorities.rows.map((row) => ({
        authority: row.authorityName,
        registration: row.registrationJurisdiction,
        accrued: moneyCsv(row.taxAccrued),
        payments: moneyCsv(row.payments),
        net: moneyCsv(row.netOutstanding),
      })),
      [
        { key: "authority", header: "Authority" },
        { key: "registration", header: "Registration" },
        { key: "accrued", header: "Tax Accrued" },
        { key: "payments", header: "Payments" },
        { key: "net", header: "Net Outstanding" },
      ],
    ),
  });

  if (filingPeriod) {
    files.push({
      filename: "filing-period-summary.csv",
      content: taxRowsToCsv(
        [
          {
            period: `${filingPeriod.periodStart} to ${filingPeriod.periodEnd}`,
            status: filingPeriod.status,
            net: moneyCsv(filingPeriod.netLiability),
            paid: moneyCsv(filingPeriod.paid),
            remaining: moneyCsv(filingPeriod.remaining),
            difference: moneyCsv(filingPeriod.reconciliationDifference),
          },
        ],
        [
          { key: "period", header: "Period" },
          { key: "status", header: "Status" },
          { key: "net", header: "Net Liability" },
          { key: "paid", header: "Paid" },
          { key: "remaining", header: "Remaining" },
          { key: "difference", header: "Reconciliation Difference" },
        ],
      ),
    });
  }

  const manifest: AccountantTaxPackageManifest = {
    organizationId: filters.organizationId,
    organizationName: options?.organizationName ?? null,
    generatedAt: new Date().toISOString(),
    reportPeriodStart: filters.startDate ?? filingPeriod?.periodStart ?? null,
    reportPeriodEnd: filters.endDate ?? filingPeriod?.periodEnd ?? null,
    filingPeriodId: filters.filingPeriodId ?? null,
    registrations: (registrations ?? []).map((row) => ({
      id: row.id as string,
      jurisdictionKey: (row.jurisdiction_key as string | null) ?? null,
      registrationNumber: (row.registration_number as string | null) ?? null,
    })),
    authorities: (authoritiesData ?? []).map((row) => {
      const authority = row.teller_tax_authorities as { name?: string } | null;
      return { id: row.authority_id as string | null, name: authority?.name ?? null };
    }),
    dateBasis: TAX_REPORT_DATE_BASIS,
    includedFiles: files.map((f) => f.filename),
    statePackVersions,
    reconciliationStatus: glReconciliation.status,
    exceptionCount: glReconciliation.exceptionCount + summary.needsReviewCount,
    reportVersion: TAX_REPORT_VERSION,
  };

  const readme = [
    "Teller Accountant Tax Package",
    `Generated: ${manifest.generatedAt}`,
    `Organization: ${manifest.organizationName ?? manifest.organizationId}`,
    `Period: ${manifest.reportPeriodStart ?? "n/a"} to ${manifest.reportPeriodEnd ?? "n/a"}`,
    `Date basis: ${manifest.dateBasis} (tax transaction date)`,
    `Report version: ${manifest.reportVersion}`,
    `Reconciliation status: ${manifest.reconciliationStatus}`,
    `Exception count: ${manifest.exceptionCount}`,
    statePackVersions.length ? `State pack versions: ${statePackVersions.join(", ")}` : "State pack versions: none active",
    "",
    "Included files:",
    ...manifest.includedFiles.map((name) => `- ${name}`),
    "",
    "Note: Reports derive from posted tax subledger records and historical determination snapshots.",
    "Teller does not provide legal tax advice or official government return forms.",
  ].join("\n");

  files.unshift({ filename: "README.txt", content: readme });

  return { manifest, files };
}
