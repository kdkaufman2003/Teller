import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { removeBankMatch } from "@/lib/banking/categorize";
import {
  confirmBankTransactionMatch,
  excludeBankTransaction,
  loadTransactionMatchSuggestions,
} from "@/lib/banking/sync";
import { TAB_STATUS_MAP, type BankTransactionTab } from "@/lib/banking/types";

function tabFromParam(value: string | null): BankTransactionTab | null {
  if (!value) return null;
  if (value in TAB_STATUS_MAP) return value as BankTransactionTab;
  return null;
}

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const url = new URL(request.url);
  const transactionId = url.searchParams.get("transactionId");
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
  const tab = tabFromParam(url.searchParams.get("tab"));
  const bankAccountId = url.searchParams.get("bankAccountId");
  const legacyStatus = url.searchParams.get("status");

  if (transactionId) {
    try {
      const payload = await loadTransactionMatchSuggestions(
        supabase,
        organizationId,
        transactionId,
      );
      return NextResponse.json(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transaction not found";
      return jsonError(message, error instanceof Error && message.includes("not found") ? 404 : 500);
    }
  }

  let query = supabase
    .from("teller_bank_transactions")
    .select(
      "id, bank_account_id, posted_date, amount, normalized_amount, direction, description, name, merchant_name, pending, status, match_status, match_confidence, metadata, provider_lifecycle_state",
    )
    .eq("organization_id", organizationId)
    .order("posted_date", { ascending: false })
    .limit(limit);

  if (bankAccountId) query = query.eq("bank_account_id", bankAccountId);
  if (tab) query = query.in("status", TAB_STATUS_MAP[tab]);
  else if (legacyStatus) query = query.eq("match_status", legacyStatus);

  const { data, error } = await query;
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ transactions: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    transactionId?: string;
    action?: "confirm" | "exclude" | "remove_match";
    matchedResourceType?: string;
    matchedResourceId?: string;
    matchedAmount?: number;
    matchId?: string;
    reason?: string;
    idempotencyEventId?: string | null;
    documentId?: string | null;
    journalEntryId?: string | null;
  };

  if (!body.transactionId && body.action !== "remove_match") {
    return jsonError("transactionId is required");
  }

  try {
    if (body.action === "exclude") {
      const result = await excludeBankTransaction(supabase, {
        organizationId,
        bankTransactionId: body.transactionId!,
        actorId: session.userId,
      });
      return NextResponse.json({ ok: true, ...result });
    }

    if (body.action === "remove_match") {
      if (!body.matchId) return jsonError("matchId is required");
      const result = await removeBankMatch(supabase, {
        organizationId,
        matchId: body.matchId,
        reason: body.reason ?? "Removed by user",
        actorId: session.userId,
      });
      return NextResponse.json({ ok: true, ...result });
    }

    const matchedResourceType =
      body.matchedResourceType ??
      (body.journalEntryId ? "journal_entry" : body.documentId ? "document" : null);
    const matchedResourceId =
      body.matchedResourceId ?? body.journalEntryId ?? body.documentId ?? null;

    if (!matchedResourceType || !matchedResourceId) {
      return jsonError("matchedResourceType and matchedResourceId are required");
    }

    const result = await confirmBankTransactionMatch(supabase, {
      organizationId,
      transactionId: body.transactionId!,
      matchedResourceType,
      matchedResourceId,
      matchedAmount: body.matchedAmount,
      idempotencyEventId: body.idempotencyEventId,
      actorId: session.userId,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Match update failed";
    return jsonError(message, 500);
  }
}
