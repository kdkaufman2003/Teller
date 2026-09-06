import type { SupabaseClient } from "@supabase/supabase-js";

export type JournalLinkKind =
  | "accrual"
  | "payment"
  | "fee"
  | "credit"
  | "refund"
  | "writeoff"
  | "reversal"
  | "adjustment";

const SOURCE_KIND_TO_LINK: Record<string, JournalLinkKind> = {
  invoice: "accrual",
  expense: "accrual",
  "invoice-payment": "payment",
  "expense-payment": "payment",
  "invoice-payment-fee": "fee",
  reversal: "reversal",
  adjustment: "adjustment",
};

export function linkKindFromSourceKind(sourceKind: string | null | undefined): JournalLinkKind | null {
  if (!sourceKind) return null;
  return SOURCE_KIND_TO_LINK[sourceKind] ?? null;
}

export async function recordDocumentJournalLink(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    journalEntryId: string;
    linkKind: JournalLinkKind;
    paymentId?: string | null;
  },
): Promise<void> {
  const { error } = await supabase.from("teller_document_journal_links").insert({
    organization_id: input.organizationId,
    document_id: input.documentId,
    journal_entry_id: input.journalEntryId,
    link_kind: input.linkKind,
    payment_id: input.paymentId ?? null,
  });

  if (error && !error.message.includes("duplicate")) {
    throw new Error(error.message);
  }
}

export type JournalLinkBackfillRow = {
  documentId: string;
  journalEntryId: string;
  linkKind: JournalLinkKind;
  paymentId?: string | null;
  action: "insert" | "skip" | "flag";
  reason?: string;
};

export async function backfillDocumentJournalLinks(
  supabase: SupabaseClient,
  organizationId: string,
  options: { apply?: boolean } = {},
): Promise<{ rows: JournalLinkBackfillRow[]; inserted: number; skipped: number; flagged: number }> {
  const rows: JournalLinkBackfillRow[] = [];
  let inserted = 0;
  let skipped = 0;
  let flagged = 0;

  const { data: documents } = await supabase
    .from("teller_documents")
    .select("id, posted_entry_id")
    .eq("organization_id", organizationId)
    .in("kind", ["invoice", "expense", "bill"]);

  for (const doc of documents ?? []) {
    const documentId = doc.id as string;
    if (doc.posted_entry_id) {
      const row = await upsertLinkBackfill(supabase, organizationId, {
        documentId,
        journalEntryId: doc.posted_entry_id as string,
        linkKind: "accrual",
        apply: options.apply,
      });
      rows.push(row);
      if (row.action === "insert") inserted += 1;
      else if (row.action === "skip") skipped += 1;
      else flagged += 1;
    }
  }

  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id, source_id, source_kind, reverses_entry_id")
    .eq("organization_id", organizationId)
    .not("source_id", "is", null);

  const { data: payments } = await supabase
    .from("teller_payments")
    .select("id, journal_entry_id, document_id")
    .eq("organization_id", organizationId)
    .not("journal_entry_id", "is", null);

  const paymentByJournal = new Map(
    (payments ?? []).map((row) => [row.journal_entry_id as string, row]),
  );

  for (const entry of entries ?? []) {
    const sourceId = entry.source_id as string;
    const sourceKind = entry.source_kind as string;
    const journalEntryId = entry.id as string;
    const linkKind = linkKindFromSourceKind(sourceKind);

    if (!linkKind) {
      rows.push({
        documentId: sourceId,
        journalEntryId,
        linkKind: "adjustment",
        action: "flag",
        reason: `unknown_source_kind:${sourceKind}`,
      });
      flagged += 1;
      continue;
    }

    const payment = paymentByJournal.get(journalEntryId);
    const row = await upsertLinkBackfill(supabase, organizationId, {
      documentId: sourceId,
      journalEntryId,
      linkKind: entry.reverses_entry_id ? "reversal" : linkKind,
      paymentId: payment?.id as string | undefined,
      apply: options.apply,
    });
    rows.push(row);
    if (row.action === "insert") inserted += 1;
    else if (row.action === "skip") skipped += 1;
    else flagged += 1;
  }

  return { rows, inserted, skipped, flagged };
}

async function upsertLinkBackfill(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    documentId: string;
    journalEntryId: string;
    linkKind: JournalLinkKind;
    paymentId?: string | null;
    apply?: boolean;
  },
): Promise<JournalLinkBackfillRow> {
  const { data: doc } = await supabase
    .from("teller_documents")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", input.documentId)
    .maybeSingle();

  if (!doc) {
    return {
      documentId: input.documentId,
      journalEntryId: input.journalEntryId,
      linkKind: input.linkKind,
      paymentId: input.paymentId,
      action: "flag",
      reason: "document_not_in_org",
    };
  }

  const { data: journal } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", input.journalEntryId)
    .maybeSingle();

  if (!journal) {
    return {
      documentId: input.documentId,
      journalEntryId: input.journalEntryId,
      linkKind: input.linkKind,
      paymentId: input.paymentId,
      action: "flag",
      reason: "journal_not_in_org",
    };
  }

  const { data: existing } = await supabase
    .from("teller_document_journal_links")
    .select("id")
    .eq("document_id", input.documentId)
    .eq("journal_entry_id", input.journalEntryId)
    .maybeSingle();

  if (existing?.id) {
    return {
      documentId: input.documentId,
      journalEntryId: input.journalEntryId,
      linkKind: input.linkKind,
      paymentId: input.paymentId,
      action: "skip",
      reason: "exists",
    };
  }

  if (input.apply) {
    await recordDocumentJournalLink(supabase, {
      organizationId,
      documentId: input.documentId,
      journalEntryId: input.journalEntryId,
      linkKind: input.linkKind,
      paymentId: input.paymentId,
    });
  }

  return {
    documentId: input.documentId,
    journalEntryId: input.journalEntryId,
    linkKind: input.linkKind,
    paymentId: input.paymentId,
    action: "insert",
  };
}
