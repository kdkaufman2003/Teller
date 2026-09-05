import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { confirmBankTransactionMatch } from "@/lib/banking/sync";
import { suggestBankTransactionMatches } from "@/lib/banking/match";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const url = new URL(request.url);
  const transactionId = url.searchParams.get("transactionId");
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
  const status = url.searchParams.get("status");

  let query = supabase
    .from("teller_bank_transactions")
    .select(
      "id, bank_account_id, posted_date, amount, name, merchant_name, pending, match_status, match_confidence, matched_document_id, matched_journal_entry_id, metadata",
    )
    .eq("organization_id", organizationId)
    .order("posted_date", { ascending: false })
    .limit(limit);

  if (status) query = query.eq("match_status", status);

  const { data, error } = await query;
  if (error) return jsonError(error.message, 500);

  if (transactionId) {
    const txn = (data ?? []).find((row) => row.id === transactionId);
    if (!txn) return jsonError("Transaction not found", 404);

    const [{ data: invoices }, { data: expenses }, { data: entries }] = await Promise.all([
      supabase
        .from("teller_documents")
        .select("id, number, total, amount_paid, issue_date, status")
        .eq("organization_id", organizationId)
        .eq("kind", "invoice"),
      supabase
        .from("teller_documents")
        .select("id, number, total, issue_date, memo")
        .eq("organization_id", organizationId)
        .eq("kind", "expense"),
      supabase
        .from("teller_journal_entries")
        .select("id, entry_date, memo")
        .eq("organization_id", organizationId),
    ]);

    const entryIds = (entries ?? []).map((row) => row.id);
    const { data: journalLines } = entryIds.length
      ? await supabase
          .from("teller_journal_lines")
          .select("entry_id, debit")
          .in("entry_id", entryIds)
          .gt("debit", 0)
      : { data: [] };

    const entryById = new Map((entries ?? []).map((row) => [row.id, row]));
    const journalDeposits = (journalLines ?? []).map((row) => {
      const entry = entryById.get(row.entry_id as string);
      return {
        id: row.entry_id as string,
        entry_date: entry?.entry_date ?? "",
        memo: entry?.memo ?? "",
        debit: Number(row.debit),
      };
    });

    return NextResponse.json({
      transaction: txn,
      suggestions: suggestBankTransactionMatches(txn, {
        invoices: invoices ?? [],
        expenses: expenses ?? [],
        journalDeposits,
      }),
    });
  }

  return NextResponse.json({ transactions: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const body = (await request.json()) as {
    transactionId?: string;
    documentId?: string | null;
    journalEntryId?: string | null;
    action?: "confirm" | "ignore";
  };

  if (!body.transactionId) return jsonError("transactionId is required");

  try {
    if (body.action === "ignore") {
      const { error } = await supabase
        .from("teller_bank_transactions")
        .update({ match_status: "ignored", updated_at: new Date().toISOString() })
        .eq("organization_id", organizationId)
        .eq("id", body.transactionId);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    await confirmBankTransactionMatch(supabase, {
      organizationId,
      transactionId: body.transactionId,
      documentId: body.documentId,
      journalEntryId: body.journalEntryId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Match update failed";
    return jsonError(message, 500);
  }
}
