import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "../../payment-fees";
import { loadTaxSettings } from "../load-tax-settings";
import { aggregateRollforward, includesVendorTaxInUseTaxLiability, type TaxTransactionForRollforward } from "./rollforward";
import type {
  TaxFilingPeriodRecord,
  TaxPeriodReconciliationResult,
  TaxReconciliationException,
  TaxRegistrationRecord,
} from "./types";
import { evaluatePeriodReadiness } from "./readiness";

export const TAX_PERIOD_RECONCILIATION_VERSION = "teller_tax_period_reconciliation_v1";

function parseRegistration(row: Record<string, unknown>): TaxRegistrationRecord {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    authorityId: (row.authority_id as string | null) ?? null,
    jurisdictionKey: (row.jurisdiction_key as string | null) ?? null,
    registrationNumber: (row.registration_number as string | null) ?? null,
    filingFrequency: row.filing_frequency as TaxRegistrationRecord["filingFrequency"],
    status: row.status as TaxRegistrationRecord["status"],
    effectiveFrom: row.effective_from as string,
    effectiveTo: (row.effective_to as string | null) ?? null,
  };
}

function parsePeriod(row: Record<string, unknown>): TaxFilingPeriodRecord {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    registrationId: row.registration_id as string,
    authorityId: (row.authority_id as string | null) ?? null,
    jurisdictionKey: (row.jurisdiction_key as string | null) ?? null,
    periodStart: row.period_start as string,
    periodEnd: row.period_end as string,
    filingFrequency: row.filing_frequency as TaxFilingPeriodRecord["filingFrequency"],
    status: row.status as TaxFilingPeriodRecord["status"],
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
  };
}

function parseTransaction(row: Record<string, unknown>): TaxTransactionForRollforward {
  return {
    id: row.id as string,
    transactionType: row.transaction_type as TaxTransactionForRollforward["transactionType"],
    transactionDate: row.transaction_date as string,
    taxAmount: Number(row.tax_amount),
    determinationStatus: row.determination_status as string,
    postedJournalEntryId: (row.posted_journal_entry_id as string | null) ?? null,
    primaryJurisdictionKey: (row.primary_jurisdiction_key as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  };
}

function transactionMatchesRegistration(
  tx: TaxTransactionForRollforward,
  registration: TaxRegistrationRecord,
): boolean {
  if (!registration.jurisdictionKey) return true;
  if (!tx.primaryJurisdictionKey) return false;
  return tx.primaryJurisdictionKey === registration.jurisdictionKey;
}

function transactionWithinRegistrationDates(
  tx: TaxTransactionForRollforward,
  registration: TaxRegistrationRecord,
): boolean {
  if (tx.transactionDate < registration.effectiveFrom) return false;
  if (registration.effectiveTo && tx.transactionDate > registration.effectiveTo) return false;
  return true;
}

function collectJournalEntryIds(transactions: TaxTransactionForRollforward[]): string[] {
  return [
    ...new Set(
      transactions
        .map((tx) => tx.postedJournalEntryId)
        .filter((id): id is string => Boolean(id?.trim())),
    ),
  ];
}

const JOURNAL_ENTRY_ID_BATCH_SIZE = 80;

/** GL tax payable movement attributable to posted tax subledger journal entries only. */
async function sumGlTaxPayableForJournalEntries(
  supabase: SupabaseClient,
  taxPayableAccountId: string,
  journalEntryIds: string[],
): Promise<number> {
  if (journalEntryIds.length === 0) return 0;

  let total = 0;
  for (let index = 0; index < journalEntryIds.length; index += JOURNAL_ENTRY_ID_BATCH_SIZE) {
    const batch = journalEntryIds.slice(index, index + JOURNAL_ENTRY_ID_BATCH_SIZE);
    const { data, error } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("account_id", taxPayableAccountId)
      .in("entry_id", batch);

    if (error) throw new Error(error.message);

    total += (data ?? []).reduce(
      (sum, line) => sum + Number(line.credit ?? 0) - Number(line.debit ?? 0),
      0,
    );
  }

  return roundMoney(total);
}

async function loadManualGlTaxLines(
  supabase: SupabaseClient,
  organizationId: string,
  taxPayableAccountId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Array<{ entryId: string; amount: number }>> {
  const { data, error } = await supabase
    .from("teller_journal_lines")
    .select("debit, credit, entry_id, teller_journal_entries!inner(id, entry_date, source_kind, organization_id)")
    .eq("account_id", taxPayableAccountId)
    .eq("teller_journal_entries.organization_id", organizationId)
    .gte("teller_journal_entries.entry_date", periodStart)
    .lte("teller_journal_entries.entry_date", periodEnd);

  if (error) throw new Error(error.message);

  const manual: Array<{ entryId: string; amount: number }> = [];
  for (const line of data ?? []) {
    const entry = line.teller_journal_entries as { id?: string; source_kind?: string };
    if (!entry?.id) continue;
    if (
      entry.source_kind === "invoice" ||
      entry.source_kind === "bill" ||
      entry.source_kind === "credit_memo" ||
      entry.source_kind === "tax-authority-payment" ||
      entry.source_kind === "tax-manual-adjustment"
    ) {
      continue;
    }
    if (entry.source_kind === "reversal") continue;
    const amount = roundMoney(Number(line.credit ?? 0) - Number(line.debit ?? 0));
    if (Math.abs(amount) <= 0.009) continue;
    manual.push({ entryId: entry.id, amount });
  }
  return manual;
}

export async function reconcileTaxPeriod(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    registrationId: string;
    periodStart: string;
    periodEnd: string;
    filingPeriodId?: string | null;
  },
): Promise<TaxPeriodReconciliationResult> {
  const { data: registrationRow, error: registrationError } = await supabase
    .from("teller_tax_registrations")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.registrationId)
    .maybeSingle();
  if (registrationError) throw new Error(registrationError.message);
  if (!registrationRow) throw new Error("Tax registration not found");

  const registration = parseRegistration(registrationRow as Record<string, unknown>);

  let period: TaxFilingPeriodRecord;
  if (input.filingPeriodId) {
    const { data: periodRow, error: periodError } = await supabase
      .from("teller_tax_filing_periods")
      .select("*")
      .eq("organization_id", input.organizationId)
      .eq("id", input.filingPeriodId)
      .maybeSingle();
    if (periodError) throw new Error(periodError.message);
    if (!periodRow) throw new Error("Filing period not found");
    period = parsePeriod(periodRow as Record<string, unknown>);
  } else {
    period = {
      id: "",
      organizationId: input.organizationId,
      registrationId: input.registrationId,
      authorityId: registration.authorityId ?? null,
      jurisdictionKey: registration.jurisdictionKey ?? null,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      filingFrequency: registration.filingFrequency,
      status: "open",
      metadata: {},
    };
  }

  const { settings } = await loadTaxSettings(supabase, input.organizationId);
  const taxPayableAccountId = settings.salesTaxPayableAccountId?.trim() ?? "";
  const exceptions: TaxReconciliationException[] = [];

  if (!taxPayableAccountId) {
    exceptions.push({
      code: "WRONG_TAX_PAYABLE_ACCOUNT",
      message: "Sales tax payable account is not configured",
      severity: "blocking",
    });
  }

  const { data: txRows, error: txError } = await supabase
    .from("teller_tax_transactions")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("is_posted", true)
    .gte("transaction_date", period.periodStart)
    .lte("transaction_date", period.periodEnd)
    .neq("transaction_type", "authority_payment");
  if (txError) throw new Error(txError.message);

  const scoped: TaxTransactionForRollforward[] = [];
  for (const row of txRows ?? []) {
    const tx = parseTransaction(row as Record<string, unknown>);
    if (!transactionMatchesRegistration(tx, registration)) continue;
    if (!transactionWithinRegistrationDates(tx, registration)) {
      exceptions.push({
        code: "TRANSACTION_OUTSIDE_REGISTRATION_DATES",
        message: `Tax transaction ${tx.id} is outside registration effective dates`,
        severity: "warning",
        taxTransactionId: tx.id,
        amount: tx.taxAmount,
      });
      continue;
    }
    if (tx.determinationStatus === "needs_review") {
      exceptions.push({
        code: "NEEDS_REVIEW_TAX_TRANSACTION",
        message: `Tax transaction ${tx.id} needs review`,
        severity: "blocking",
        taxTransactionId: tx.id,
        amount: tx.taxAmount,
      });
    }
    scoped.push(tx);
  }

  if (includesVendorTaxInUseTaxLiability(scoped)) {
    exceptions.push({
      code: "COMPONENT_MISMATCH",
      message: "Vendor-charged tax must not be included in use-tax liability",
      severity: "blocking",
    });
  }

  const { data: paymentRows, error: paymentError } = await supabase
    .from("teller_tax_transactions")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("is_posted", true)
    .gte("transaction_date", period.periodStart)
    .lte("transaction_date", period.periodEnd)
    .in("transaction_type", ["authority_payment", "tax_adjustment"]);
  if (paymentError) throw new Error(paymentError.message);

  const periodPayments: TaxTransactionForRollforward[] = [];
  for (const row of paymentRows ?? []) {
    const tx = parseTransaction(row as Record<string, unknown>);
    if (tx.transactionType === "tax_adjustment") {
      const metadata = (tx.metadata ?? {}) as Record<string, unknown>;
      if (!metadata.authorityPaymentReversal) continue;
    }
    if (!transactionMatchesRegistration(tx, registration)) continue;
    periodPayments.push(tx);
  }

  const { data: priorRows } = await supabase
    .from("teller_tax_transactions")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("is_posted", true)
    .lt("transaction_date", period.periodStart);

  const priorScoped = (priorRows ?? [])
    .map((row) => parseTransaction(row as Record<string, unknown>))
    .filter((tx) => transactionMatchesRegistration(tx, registration));

  const { data: endingRows } = await supabase
    .from("teller_tax_transactions")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("is_posted", true)
    .lte("transaction_date", period.periodEnd);

  const endingScoped = (endingRows ?? [])
    .map((row) => parseTransaction(row as Record<string, unknown>))
    .filter((tx) => transactionMatchesRegistration(tx, registration));

  const periodRollforward = aggregateRollforward(scoped);
  const periodPaymentRollforward = aggregateRollforward(periodPayments);
  const beginningRollforward = aggregateRollforward(priorScoped);
  const endingRollforward = aggregateRollforward(endingScoped);
  const beginningSubledgerLiability = roundMoney(beginningRollforward.totals.netAmount);
  const endingSubledgerLiability = roundMoney(endingRollforward.totals.netAmount);
  const endingOutstandingLiability = endingSubledgerLiability;

  const allPeriodScoped = [...scoped, ...periodPayments];
  const priorJournalEntryIds = collectJournalEntryIds(priorScoped);
  const periodJournalEntryIds = collectJournalEntryIds(allPeriodScoped);
  const endingJournalEntryIds = collectJournalEntryIds(endingScoped);

  let beginningGlBalance = 0;
  let periodGlMovement = 0;
  let endingGlBalance = 0;
  if (taxPayableAccountId) {
    beginningGlBalance = await sumGlTaxPayableForJournalEntries(
      supabase,
      taxPayableAccountId,
      priorJournalEntryIds,
    );
    periodGlMovement = await sumGlTaxPayableForJournalEntries(
      supabase,
      taxPayableAccountId,
      periodJournalEntryIds,
    );
    endingGlBalance = await sumGlTaxPayableForJournalEntries(
      supabase,
      taxPayableAccountId,
      endingJournalEntryIds,
    );
  }

  const periodSubledgerNet = roundMoney(
    periodRollforward.totals.netAmount + periodPaymentRollforward.totals.netAmount,
  );
  const periodSubledgerToGlDifference = roundMoney(periodSubledgerNet - periodGlMovement);
  if (Math.abs(periodSubledgerToGlDifference) > 0.009) {
    exceptions.push({
      code: "SUBLEDGER_GL_DIFFERENCE",
      message: `Period subledger ${periodRollforward.totals.netAmount} differs from linked GL ${periodGlMovement}`,
      severity: "blocking",
      amount: periodSubledgerToGlDifference,
    });
  }

  const subledgerToGlDifference = roundMoney(endingSubledgerLiability - endingGlBalance);
  const glRollforwardDifference = roundMoney(
    beginningGlBalance + periodGlMovement - endingGlBalance,
  );

  if (Math.abs(subledgerToGlDifference) > 0.009) {
    exceptions.push({
      code: "SUBLEDGER_GL_DIFFERENCE",
      message: `Subledger ending ${endingSubledgerLiability} differs from GL ${endingGlBalance}`,
      severity: "blocking",
      amount: subledgerToGlDifference,
    });
  }

  for (const tx of scoped) {
    if (!tx.postedJournalEntryId) {
      exceptions.push({
        code: "TAX_SUBLEDGER_WITHOUT_GL",
        message: `Tax transaction ${tx.id} has no posted journal entry`,
        severity: "blocking",
        taxTransactionId: tx.id,
        amount: tx.taxAmount,
      });
    }
  }

  if (taxPayableAccountId) {
    const manualGl = await loadManualGlTaxLines(
      supabase,
      input.organizationId,
      taxPayableAccountId,
      period.periodStart,
      period.periodEnd,
    );
    for (const row of manualGl) {
      const { count } = await supabase
        .from("teller_tax_transactions")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", input.organizationId)
        .eq("posted_journal_entry_id", row.entryId);
      if ((count ?? 0) === 0) {
        exceptions.push({
          code: "GL_WITHOUT_TAX_SUBLEDGER",
          message: `Manual GL entry ${row.entryId} affects tax payable without tax subledger`,
          severity: "warning",
          journalEntryId: row.entryId,
          amount: row.amount,
        });
      }
    }
  }

  const readiness = evaluatePeriodReadiness(exceptions);

  return {
    period,
    registration,
    salesTaxAccrued: periodRollforward.totals.salesTaxAccrued,
    useTaxAccrued: periodRollforward.totals.useTaxAccrued,
    salesTaxCredits: periodRollforward.totals.salesTaxCredits,
    useTaxReversals: periodRollforward.totals.useTaxReversals,
    taxAdjustments: periodRollforward.totals.taxAdjustments,
    netSubledgerLiability: periodRollforward.totals.netAmount,
    authorityPaymentsApplied: periodPaymentRollforward.totals.authorityPayments,
    beginningSubledgerLiability,
    endingSubledgerLiability,
    endingOutstandingLiability,
    beginningGlBalance,
    periodGlMovement,
    endingGlBalance,
    subledgerToGlDifference,
    glRollforwardDifference,
    rollforward: [
      { category: "beginning_liability", amount: beginningSubledgerLiability, transactionCount: priorScoped.length },
      ...periodRollforward.lines.filter((line) => line.category !== "ending_subledger_liability"),
      {
        category: "authority_payment",
        amount: periodPaymentRollforward.totals.authorityPayments,
        transactionCount: periodPayments.length,
      },
      {
        category: "ending_subledger_liability",
        amount: endingOutstandingLiability,
        transactionCount: endingScoped.length,
      },
    ],
    exceptions,
    readiness,
    transactionIds: [...scoped, ...periodPayments].map((tx) => tx.id),
    calculationVersion: TAX_PERIOD_RECONCILIATION_VERSION,
  };
}
