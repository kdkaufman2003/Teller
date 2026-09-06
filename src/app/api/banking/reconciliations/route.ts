import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import {
  addReconciliationItems,
  finalizeBankReconciliation,
  loadReconciliationSummary,
  priorCompletedReconciliationBalance,
  reopenBankReconciliation,
  startBankReconciliation,
} from "@/lib/banking/reconciliation";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const url = new URL(request.url);
  const reconciliationId = url.searchParams.get("reconciliationId");
  const bankAccountId = url.searchParams.get("bankAccountId");

  if (reconciliationId) {
    try {
      const summary = await loadReconciliationSummary(
        supabase,
        organizationId,
        reconciliationId,
      );
      return NextResponse.json({ summary });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load reconciliation";
      return jsonError(message, 500);
    }
  }

  let query = supabase
    .from("teller_bank_reconciliations")
    .select("*")
    .eq("organization_id", organizationId)
    .order("statement_end_date", { ascending: false })
    .limit(20);

  if (bankAccountId) query = query.eq("bank_account_id", bankAccountId);

  const { data, error } = await query;
  if (error) return jsonError(error.message, 500);

  let beginningBalance: number | null = null;
  if (bankAccountId) {
    beginningBalance = await priorCompletedReconciliationBalance(
      supabase,
      organizationId,
      bankAccountId,
    );
  }

  return NextResponse.json({
    reconciliations: data ?? [],
    suggestedBeginningBalance: beginningBalance,
  });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    action?: "start" | "add_items" | "finalize" | "reopen";
    bankAccountId?: string;
    reconciliationId?: string;
    statementStartDate?: string;
    statementEndDate?: string;
    statementEndingBalance?: number;
    beginningReconciledBalance?: number | null;
    items?: Array<{
      journalEntryId?: string | null;
      journalLineId?: string | null;
      bankTransactionId?: string | null;
      clearedAmount: number;
      clearedDate: string;
    }>;
    reason?: string;
  };

  try {
    if (body.action === "start") {
      if (!body.bankAccountId || !body.statementStartDate || !body.statementEndDate) {
        return jsonError("bankAccountId, statementStartDate, and statementEndDate are required");
      }
      if (body.statementEndingBalance == null) {
        return jsonError("statementEndingBalance is required");
      }

      const started = await startBankReconciliation(supabase, {
        organizationId,
        bankAccountId: body.bankAccountId,
        statementStartDate: body.statementStartDate,
        statementEndDate: body.statementEndDate,
        statementEndingBalance: body.statementEndingBalance,
        beginningReconciledBalance: body.beginningReconciledBalance,
        actorId: session.userId,
      });
      return NextResponse.json({ ok: true, ...started });
    }

    if (!body.reconciliationId) return jsonError("reconciliationId is required");

    if (body.action === "add_items") {
      const count = await addReconciliationItems(supabase, {
        organizationId,
        reconciliationId: body.reconciliationId,
        items: body.items ?? [],
      });
      const summary = await loadReconciliationSummary(
        supabase,
        organizationId,
        body.reconciliationId,
      );
      return NextResponse.json({ ok: true, itemsAdded: count, summary });
    }

    if (body.action === "finalize") {
      const result = await finalizeBankReconciliation(supabase, {
        organizationId,
        reconciliationId: body.reconciliationId,
        actorId: session.userId,
      });
      return NextResponse.json({ ok: true, ...result });
    }

    if (body.action === "reopen") {
      if (!body.reason?.trim()) return jsonError("reason is required");
      const result = await reopenBankReconciliation(supabase, {
        organizationId,
        reconciliationId: body.reconciliationId,
        reason: body.reason,
        actorId: session.userId,
      });
      return NextResponse.json({ ok: true, ...result });
    }

    return jsonError("action must be start, add_items, finalize, or reopen");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reconciliation action failed";
    return jsonError(message, 500);
  }
}
