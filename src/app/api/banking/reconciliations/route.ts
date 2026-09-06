import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import {
  addReconciliationItems,
  finalizeBankReconciliation,
  getActiveReconciliationForAccount,
  getLastCompletedReconciliation,
  loadReconciliationLandingAccounts,
  loadReconciliationSummary,
  loadReconciliationWorkspace,
  priorCompletedReconciliationBalance,
  removeReconciliationItems,
  reopenBankReconciliation,
  startBankReconciliation,
  toggleReconciliationBankTransaction,
} from "@/lib/banking/reconciliation";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const url = new URL(request.url);
  const reconciliationId = url.searchParams.get("reconciliationId");
  const bankAccountId = url.searchParams.get("bankAccountId");
  const view = url.searchParams.get("view");
  const includeWorkspace = url.searchParams.get("includeWorkspace") === "true";
  const activeOnly = url.searchParams.get("active") === "true";

  if (view === "landing") {
    try {
      const accounts = await loadReconciliationLandingAccounts(supabase, organizationId);
      return NextResponse.json({ accounts });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load reconciliation landing";
      return jsonError(message, 500);
    }
  }

  if (reconciliationId) {
    try {
      if (includeWorkspace) {
        const workspace = await loadReconciliationWorkspace(
          supabase,
          organizationId,
          reconciliationId,
        );
        return NextResponse.json({ workspace });
      }
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

  if (bankAccountId && activeOnly) {
    try {
      const active = await getActiveReconciliationForAccount(
        supabase,
        organizationId,
        bankAccountId,
      );
      return NextResponse.json({ activeReconciliation: active });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load active reconciliation";
      return jsonError(message, 500);
    }
  }

  let query = supabase
    .from("teller_bank_reconciliations")
    .select("*")
    .eq("organization_id", organizationId)
    .order("statement_end_date", { ascending: false })
    .limit(50);

  if (bankAccountId) query = query.eq("bank_account_id", bankAccountId);

  const { data, error } = await query;
  if (error) return jsonError(error.message, 500);

  const reconciliations = await Promise.all(
    (data ?? []).map(async (row) => {
      const summary = await loadReconciliationSummary(
        supabase,
        organizationId,
        row.id as string,
      );
      return {
        ...row,
        summary,
      };
    }),
  );

  let beginningBalance: number | null = null;
  let lastCompleted: Awaited<ReturnType<typeof getLastCompletedReconciliation>> = null;
  if (bankAccountId) {
    beginningBalance = await priorCompletedReconciliationBalance(
      supabase,
      organizationId,
      bankAccountId,
    );
    lastCompleted = await getLastCompletedReconciliation(
      supabase,
      organizationId,
      bankAccountId,
    );
  }

  return NextResponse.json({
    reconciliations,
    suggestedBeginningBalance: beginningBalance,
    lastCompletedReconciliation: lastCompleted,
  });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    action?:
      | "start"
      | "add_items"
      | "remove_items"
      | "toggle_item"
      | "finalize"
      | "reopen";
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
    itemIds?: string[];
    bankTransactionIds?: string[];
    bankTransactionId?: string;
    cleared?: boolean;
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

    if (body.action === "remove_items") {
      const count = await removeReconciliationItems(supabase, {
        organizationId,
        reconciliationId: body.reconciliationId,
        itemIds: body.itemIds,
        bankTransactionIds: body.bankTransactionIds,
      });
      const summary = await loadReconciliationSummary(
        supabase,
        organizationId,
        body.reconciliationId,
      );
      return NextResponse.json({ ok: true, itemsRemoved: count, summary });
    }

    if (body.action === "toggle_item") {
      if (!body.bankTransactionId || body.cleared == null) {
        return jsonError("bankTransactionId and cleared are required");
      }
      const result = await toggleReconciliationBankTransaction(supabase, {
        organizationId,
        reconciliationId: body.reconciliationId,
        bankTransactionId: body.bankTransactionId,
        cleared: body.cleared,
      });
      const workspace = await loadReconciliationWorkspace(
        supabase,
        organizationId,
        body.reconciliationId,
      );
      return NextResponse.json({ ok: true, summary: result.summary, workspace });
    }

    if (body.action === "finalize") {
      const result = await finalizeBankReconciliation(supabase, {
        organizationId,
        reconciliationId: body.reconciliationId,
        actorId: session.userId,
      });
      const workspace = await loadReconciliationWorkspace(
        supabase,
        organizationId,
        body.reconciliationId,
      );
      return NextResponse.json({ ok: true, ...result, workspace });
    }

    if (body.action === "reopen") {
      if (!body.reason?.trim()) return jsonError("reason is required");
      const result = await reopenBankReconciliation(supabase, {
        organizationId,
        reconciliationId: body.reconciliationId,
        reason: body.reason,
        actorId: session.userId,
      });
      const workspace = await loadReconciliationWorkspace(
        supabase,
        organizationId,
        body.reconciliationId,
      );
      return NextResponse.json({ ok: true, ...result, workspace });
    }

    return jsonError(
      "action must be start, add_items, remove_items, toggle_item, finalize, or reopen",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reconciliation action failed";
    const status = message.toLowerCase().includes("closed")
      ? 409
      : message.toLowerCase().includes("permission") ||
          message.toLowerCase().includes("authorized")
        ? 403
        : 500;
    return jsonError(message, status);
  }
}
