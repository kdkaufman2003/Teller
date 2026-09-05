import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import {
  authoritativeDocumentAmountPaid,
  documentRemainingBalance,
  ledgerDerivedDocumentPaymentTotal,
} from "./balances";
import { assertBalanced } from "./post";
import { roundMoney } from "./payment-fees";

export type IntegritySeverity = "warning" | "error";

export type IntegrityIssue = {
  code: string;
  severity: IntegritySeverity;
  message: string;
  resourceKind: string;
  resourceId: string;
  details?: Record<string, unknown>;
};

type DocumentRow = {
  id: string;
  kind: string;
  number: string;
  status: string;
  total: number | string;
  amount_paid?: number | string;
  posted_entry_id?: string | null;
};

export async function runFinancialIntegrityChecks(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];

  const [{ data: documents }, { data: entries }, { data: payments }] = await Promise.all([
    supabase
      .from("teller_documents")
      .select("id, kind, number, status, total, amount_paid, posted_entry_id")
      .eq("organization_id", organizationId)
      .in("kind", ["invoice", "expense"]),
    supabase
      .from("teller_journal_entries")
      .select("id, source_kind, source_id, reverses_entry_id, memo")
      .eq("organization_id", organizationId),
    supabase
      .from("teller_payments")
      .select("id, document_id, amount, journal_entry_id")
      .eq("organization_id", organizationId),
  ]);

  const entryIds = (entries ?? []).map((row) => row.id as string);
  const { data: lines } = entryIds.length
    ? await supabase
        .from("teller_journal_lines")
        .select("entry_id, debit, credit")
        .in("entry_id", entryIds)
    : { data: [] as { entry_id: string; debit: number; credit: number }[] };

  const linesByEntry = new Map<string, { debit: number; credit: number }[]>();
  for (const line of lines ?? []) {
    const bucket = linesByEntry.get(line.entry_id) ?? [];
    bucket.push({ debit: asNumber(line.debit), credit: asNumber(line.credit) });
    linesByEntry.set(line.entry_id, bucket);
  }

  for (const [entryId, entryLines] of linesByEntry) {
    try {
      assertBalanced(
        entryLines.map((line, index) => ({
          account_id: `line-${index}`,
          debit: line.debit,
          credit: line.credit,
        })),
      );
    } catch (error) {
      issues.push({
        code: "journal.unbalanced",
        severity: "error",
        message: error instanceof Error ? error.message : "Unbalanced journal entry",
        resourceKind: "journal_entry",
        resourceId: entryId,
      });
    }
  }

  for (const doc of (documents ?? []) as DocumentRow[]) {
    if (doc.status === "void") continue;

    const kind = doc.kind === "invoice" ? "invoice" : "expense";
    const authoritativePaid = await authoritativeDocumentAmountPaid(
      supabase,
      organizationId,
      doc.id,
    );
    const cachedPaid = roundMoney(asNumber(doc.amount_paid));
    const ledgerPaid = await ledgerDerivedDocumentPaymentTotal(
      supabase,
      organizationId,
      doc.id,
      kind,
    );
    const remaining = documentRemainingBalance(asNumber(doc.total), authoritativePaid);

    if (Math.abs(authoritativePaid - cachedPaid) > 0.009) {
      issues.push({
        code: kind === "invoice" ? "ar.cache_mismatch" : "ap.cache_mismatch",
        severity: "error",
        message: `${doc.number} cached amount_paid (${cachedPaid}) != payment records (${authoritativePaid})`,
        resourceKind: kind,
        resourceId: doc.id,
        details: { cachedPaid, authoritativePaid, ledgerPaid },
      });
    }

    if (Math.abs(authoritativePaid - ledgerPaid) > 0.009) {
      issues.push({
        code: kind === "invoice" ? "ar.ledger_mismatch" : "ap.ledger_mismatch",
        severity: "warning",
        message: `${doc.number} payment records (${authoritativePaid}) != ledger-derived (${ledgerPaid})`,
        resourceKind: kind,
        resourceId: doc.id,
        details: { authoritativePaid, ledgerPaid },
      });
    }

    if (doc.status === "paid" && remaining > 0.009) {
      issues.push({
        code: kind === "invoice" ? "ar.paid_with_balance" : "ap.paid_with_balance",
        severity: "error",
        message: `${doc.number} marked paid but remaining balance is ${remaining.toFixed(2)}`,
        resourceKind: kind,
        resourceId: doc.id,
        details: { remaining, authoritativePaid, total: asNumber(doc.total) },
      });
    }
  }

  const voidDocs = new Set(
    (documents ?? []).filter((row) => row.status === "void").map((row) => row.id as string),
  );

  for (const entry of entries ?? []) {
    const sourceId = entry.source_id as string | null;
    if (!sourceId || !voidDocs.has(sourceId) || entry.reverses_entry_id) continue;

    const { count } = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("reverses_entry_id", entry.id);

    if ((count ?? 0) === 0) {
      issues.push({
        code: "void.unreversed_journal",
        severity: "error",
        message: "Void document still has unreversed source journal entry",
        resourceKind: "journal_entry",
        resourceId: entry.id as string,
        details: { sourceId, sourceKind: entry.source_kind },
      });
    }
  }

  for (const payment of payments ?? []) {
    if (!payment.journal_entry_id) {
      issues.push({
        code: "payment.missing_journal",
        severity: "error",
        message: "Payment record has no linked journal entry",
        resourceKind: "payment",
        resourceId: payment.id as string,
        details: { documentId: payment.document_id },
      });
    }
    if (!payment.document_id) {
      issues.push({
        code: "payment.missing_document",
        severity: "warning",
        message: "Payment record is not linked to a business document",
        resourceKind: "payment",
        resourceId: payment.id as string,
      });
    }
  }

  return issues;
}
