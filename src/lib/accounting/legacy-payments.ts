import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import {
  authoritativeDocumentAmountPaid,
  documentRemainingBalance,
  ledgerDerivedDocumentPaymentTotal,
  type DocumentKind,
} from "./balances";
import { roundMoney } from "./payment-fees";

export type LegacyPaymentClassification =
  | "CONSISTENT"
  | "CACHE_ONLY_PAYMENT"
  | "LEDGER_ONLY_PAYMENT"
  | "PAYMENT_RECORD_ONLY"
  | "MISMATCH"
  | "PAID_STATUS_MISMATCH"
  | "VOID_MISMATCH";

export type LegacyPaymentAuditRow = {
  documentId: string;
  documentType: DocumentKind;
  number: string;
  status: string;
  documentTotal: number;
  cachedPaid: number;
  paymentsSum: number;
  ledgerPaid: number;
  difference: number;
  classification: LegacyPaymentClassification;
};

export type LegacyPaymentAuditSummary = {
  total: number;
  byClassification: Record<LegacyPaymentClassification, number>;
  rows: LegacyPaymentAuditRow[];
};

const TOLERANCE = 0.009;

export function classifyLegacyPaymentDocument(input: {
  kind: DocumentKind;
  status: string;
  documentTotal: number;
  cachedPaid: number;
  paymentsSum: number;
  ledgerPaid: number;
}): LegacyPaymentClassification {
  const total = roundMoney(asNumber(input.documentTotal));
  const cached = roundMoney(asNumber(input.cachedPaid));
  const payments = roundMoney(asNumber(input.paymentsSum));
  const ledger = roundMoney(asNumber(input.ledgerPaid));
  const authoritative = payments;
  const remaining = documentRemainingBalance(total, authoritative);

  if (input.status === "void") {
    if (cached > TOLERANCE || payments > TOLERANCE || ledger > TOLERANCE) {
      return "VOID_MISMATCH";
    }
    return "CONSISTENT";
  }

  if (input.status === "paid" && remaining > TOLERANCE) {
    return "PAID_STATUS_MISMATCH";
  }

  const cacheLedgerMatch = Math.abs(cached - ledger) <= TOLERANCE;
  const cachePaymentsMatch = Math.abs(cached - payments) <= TOLERANCE;
  const ledgerPaymentsMatch = Math.abs(ledger - payments) <= TOLERANCE;

  if (cachePaymentsMatch && ledgerPaymentsMatch && cacheLedgerMatch) {
    return "CONSISTENT";
  }

  if (payments > TOLERANCE && ledger <= TOLERANCE && Math.abs(cached - payments) <= TOLERANCE) {
    return "PAYMENT_RECORD_ONLY";
  }

  if (ledger > TOLERANCE && payments <= TOLERANCE && cached <= TOLERANCE) {
    return "LEDGER_ONLY_PAYMENT";
  }

  if (cached > TOLERANCE && payments <= TOLERANCE && ledger <= TOLERANCE) {
    return "CACHE_ONLY_PAYMENT";
  }

  if (ledger > TOLERANCE && payments <= TOLERANCE) {
    return "LEDGER_ONLY_PAYMENT";
  }

  return "MISMATCH";
}

export async function auditLegacyPayments(
  supabase: SupabaseClient,
  organizationId?: string,
): Promise<LegacyPaymentAuditSummary> {
  let query = supabase
    .from("teller_documents")
    .select("id, kind, number, status, total, amount_paid, organization_id")
    .in("kind", ["invoice", "expense"]);

  if (organizationId) {
    query = query.eq("organization_id", organizationId);
  }

  const { data: documents, error } = await query;
  if (error) throw new Error(error.message);

  const rows: LegacyPaymentAuditRow[] = [];
  const byClassification = {
    CONSISTENT: 0,
    CACHE_ONLY_PAYMENT: 0,
    LEDGER_ONLY_PAYMENT: 0,
    PAYMENT_RECORD_ONLY: 0,
    MISMATCH: 0,
    PAID_STATUS_MISMATCH: 0,
    VOID_MISMATCH: 0,
  } satisfies Record<LegacyPaymentClassification, number>;

  for (const doc of documents ?? []) {
    const kind = doc.kind as DocumentKind;
    const orgId = doc.organization_id as string;
    const cachedPaid = roundMoney(asNumber(doc.amount_paid));
    const documentTotal = roundMoney(asNumber(doc.total));

    const [paymentsSum, ledgerPaid] = await Promise.all([
      authoritativeDocumentAmountPaid(supabase, orgId, doc.id as string),
      ledgerDerivedDocumentPaymentTotal(supabase, orgId, doc.id as string, kind),
    ]);

    const classification = classifyLegacyPaymentDocument({
      kind,
      status: doc.status as string,
      documentTotal,
      cachedPaid,
      paymentsSum,
      ledgerPaid,
    });

    byClassification[classification] += 1;
    rows.push({
      documentId: doc.id as string,
      documentType: kind,
      number: doc.number as string,
      status: doc.status as string,
      documentTotal,
      cachedPaid,
      paymentsSum,
      ledgerPaid,
      difference: roundMoney(Math.max(cachedPaid, paymentsSum, ledgerPaid) - paymentsSum),
      classification,
    });
  }

  return { total: rows.length, byClassification, rows };
}

type PaymentJournalCandidate = {
  entryId: string;
  entryDate: string;
  amount: number;
  documentId: string;
  organizationId: string;
  partyId: string | null;
  externalSource: string | null;
  externalId: string | null;
  processor: string | null;
  confidence: "ledger_journal" | "cache_with_ledger";
};

export async function findLegacyBackfillCandidates(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<PaymentJournalCandidate[]> {
  const audit = await auditLegacyPayments(supabase, organizationId);
  const candidates: PaymentJournalCandidate[] = [];

  const targetDocs = audit.rows.filter(
    (row) =>
      row.classification === "LEDGER_ONLY_PAYMENT" ||
      row.classification === "CACHE_ONLY_PAYMENT",
  );

  for (const row of targetDocs) {
    const sourceKinds =
      row.documentType === "invoice" ? ["invoice-payment"] : ["expense-payment"];

    const { data: entries, error } = await supabase
      .from("teller_journal_entries")
      .select("id, entry_date, source_id, organization_id")
      .eq("organization_id", organizationId)
      .eq("source_id", row.documentId)
      .in("source_kind", sourceKinds)
      .is("reverses_entry_id", null);

    if (error) throw new Error(error.message);

    const entryIds = (entries ?? []).map((entry) => entry.id as string);
    if (!entryIds.length) continue;

    const { data: reversed } = await supabase
      .from("teller_journal_entries")
      .select("reverses_entry_id")
      .in("reverses_entry_id", entryIds);

    const reversedIds = new Set(
      (reversed ?? []).map((item) => item.reverses_entry_id as string),
    );
    const liveEntries = (entries ?? []).filter(
      (entry) => !reversedIds.has(entry.id as string),
    );

    const { data: accounts } = await supabase
      .from("teller_accounts")
      .select("id, code, subtype")
      .eq("organization_id", organizationId);

    const arApAccount = (accounts ?? []).find((account) =>
      row.documentType === "invoice"
        ? account.subtype === "receivable" || account.code === "1100"
        : account.subtype === "payable" || account.code === "2000",
    );

    if (!arApAccount) continue;

    for (const entry of liveEntries) {
      const { data: existingPayment } = await supabase
        .from("teller_payments")
        .select("id")
        .eq("journal_entry_id", entry.id)
        .maybeSingle();

      if (existingPayment?.id) continue;

      const { data: lines } = await supabase
        .from("teller_journal_lines")
        .select("debit, credit, party_id")
        .eq("entry_id", entry.id)
        .eq("account_id", arApAccount.id);

      const amount = roundMoney(
        (lines ?? []).reduce((sum, line) => {
          if (row.documentType === "invoice") return sum + asNumber(line.credit);
          return sum + asNumber(line.debit);
        }, 0),
      );

      if (amount <= TOLERANCE) continue;

      if (
        row.classification === "CACHE_ONLY_PAYMENT" &&
        Math.abs(amount - row.cachedPaid) > TOLERANCE
      ) {
        continue;
      }

      candidates.push({
        entryId: entry.id as string,
        entryDate: entry.entry_date as string,
        amount,
        documentId: row.documentId,
        organizationId,
        partyId: (lines?.[0]?.party_id as string | null) ?? null,
        externalSource: null,
        externalId: null,
        processor: null,
        confidence:
          row.classification === "LEDGER_ONLY_PAYMENT"
            ? "ledger_journal"
            : "cache_with_ledger",
      });
    }
  }

  return candidates;
}

export type LegacyBackfillResult = {
  dryRun: boolean;
  organizationId: string;
  candidates: number;
  inserted: number;
  skipped: number;
  flaggedForReview: number;
  records: Array<{
    documentId: string;
    entryId: string;
    amount: number;
    action: "insert" | "skip" | "flag";
    reason?: string;
  }>;
};

export async function backfillLegacyPayments(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    dryRun: boolean;
  },
): Promise<LegacyBackfillResult> {
  const candidates = await findLegacyBackfillCandidates(supabase, input.organizationId);
  const audit = await auditLegacyPayments(supabase, input.organizationId);
  const flagged = audit.rows.filter(
    (row) =>
      row.classification === "MISMATCH" ||
      row.classification === "PAYMENT_RECORD_ONLY" ||
      row.classification === "VOID_MISMATCH" ||
      row.classification === "PAID_STATUS_MISMATCH",
  );

  const result: LegacyBackfillResult = {
    dryRun: input.dryRun,
    organizationId: input.organizationId,
    candidates: candidates.length,
    inserted: 0,
    skipped: 0,
    flaggedForReview: flagged.length,
    records: [],
  };

  for (const candidate of candidates) {
    const { data: existing } = await supabase
      .from("teller_payments")
      .select("id")
      .eq("journal_entry_id", candidate.entryId)
      .maybeSingle();

    if (existing?.id) {
      result.skipped += 1;
      result.records.push({
        documentId: candidate.documentId,
        entryId: candidate.entryId,
        amount: candidate.amount,
        action: "skip",
        reason: "payment_already_exists",
      });
      continue;
    }

    if (input.dryRun) {
      result.inserted += 1;
      result.records.push({
        documentId: candidate.documentId,
        entryId: candidate.entryId,
        amount: candidate.amount,
        action: "insert",
      });
      continue;
    }

    const { error } = await supabase.from("teller_payments").insert({
      organization_id: candidate.organizationId,
      document_id: candidate.documentId,
      party_id: candidate.partyId,
      amount: candidate.amount,
      fee_amount: 0,
      net_amount: candidate.amount,
      payment_date: candidate.entryDate,
      processor: candidate.processor,
      external_source: candidate.externalSource,
      external_id: candidate.externalId,
      journal_entry_id: candidate.entryId,
      metadata: {
        source: "legacy_backfill",
        backfilled_at: new Date().toISOString(),
        source_journal_entry_id: candidate.entryId,
        confidence: candidate.confidence,
      },
    });

    if (error) {
      if (error.message.includes("duplicate")) {
        result.skipped += 1;
        result.records.push({
          documentId: candidate.documentId,
          entryId: candidate.entryId,
          amount: candidate.amount,
          action: "skip",
          reason: "duplicate",
        });
      } else {
        throw new Error(error.message);
      }
    } else {
      result.inserted += 1;
      result.records.push({
        documentId: candidate.documentId,
        entryId: candidate.entryId,
        amount: candidate.amount,
        action: "insert",
      });
    }
  }

  for (const row of flagged) {
    result.records.push({
      documentId: row.documentId,
      entryId: "",
      amount: row.cachedPaid,
      action: "flag",
      reason: row.classification,
    });
  }

  return result;
}

export type SubledgerReconciliation = {
  kind: "invoice" | "expense";
  documentRemainingTotal: number;
  controlAccountBalance: number;
  difference: number;
  consistent: boolean;
};

export async function reconcileSubledgerToControl(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<SubledgerReconciliation[]> {
  const results: SubledgerReconciliation[] = [];

  for (const kind of ["invoice", "expense"] as const) {
    const { data: documents } = await supabase
      .from("teller_documents")
      .select("id, total, status")
      .eq("organization_id", organizationId)
      .eq("kind", kind)
      .neq("status", "void");

    let documentRemainingTotal = 0;
    for (const doc of documents ?? []) {
      const paid = await authoritativeDocumentAmountPaid(
        supabase,
        organizationId,
        doc.id as string,
      );
      documentRemainingTotal += documentRemainingBalance(doc.total, paid);
    }
    documentRemainingTotal = roundMoney(documentRemainingTotal);

    const { data: accounts } = await supabase
      .from("teller_accounts")
      .select("id, code, subtype")
      .eq("organization_id", organizationId);

    const control = (accounts ?? []).find((account) =>
      kind === "invoice"
        ? account.subtype === "receivable" || account.code === "1100"
        : account.subtype === "payable" || account.code === "2000",
    );

    if (!control) {
      results.push({
        kind,
        documentRemainingTotal,
        controlAccountBalance: 0,
        difference: documentRemainingTotal,
        consistent: false,
      });
      continue;
    }

    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit, entry_id")
      .eq("account_id", control.id);

    const entryIds = [...new Set((lines ?? []).map((line) => line.entry_id as string))];
    const { data: entries } = entryIds.length
      ? await supabase
          .from("teller_journal_entries")
          .select("id, reverses_entry_id")
          .eq("organization_id", organizationId)
          .in("id", entryIds)
      : { data: [] };

    const reversedIds = new Set(
      (entries ?? [])
        .filter((entry) => entry.reverses_entry_id)
        .map((entry) => entry.id as string),
    );

    const { data: reversals } = entryIds.length
      ? await supabase
          .from("teller_journal_entries")
          .select("reverses_entry_id")
          .in("reverses_entry_id", entryIds)
      : { data: [] };

    const reversedEntryIds = new Set(
      (reversals ?? []).map((row) => row.reverses_entry_id as string),
    );

    const controlAccountBalance = roundMoney(
      (lines ?? []).reduce((sum, line) => {
        if (reversedEntryIds.has(line.entry_id as string)) return sum;
        if (reversedIds.has(line.entry_id as string)) return sum;
        if (kind === "invoice") {
          return sum + asNumber(line.debit) - asNumber(line.credit);
        }
        return sum + asNumber(line.credit) - asNumber(line.debit);
      }, 0),
    );

    const difference = roundMoney(Math.abs(documentRemainingTotal - controlAccountBalance));
    results.push({
      kind,
      documentRemainingTotal,
      controlAccountBalance,
      difference,
      consistent: difference <= TOLERANCE,
    });
  }

  return results;
}
