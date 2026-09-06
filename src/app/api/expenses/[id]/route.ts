import { NextResponse } from "next/server";
import {
  documentRemainingBalance,
  resolveDocumentAmountPaid,
} from "@/lib/accounting/balances";
import { postExpensePaid, voidExpense } from "@/lib/accounting/post";
import { asNumber, todayISO } from "@/lib/format";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const { id } = await params;

  const { data: expense, error } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("kind", "expense")
    .eq("id", id)
    .maybeSingle();

  if (error || !expense) return jsonError("Expense not found", 404);

  const amountPaid = await resolveDocumentAmountPaid(
    supabase,
    organizationId,
    id,
    asNumber(expense.amount_paid),
  );
  const remaining = documentRemainingBalance(expense.total, amountPaid);

  return NextResponse.json({
    expense: { ...expense, amount_paid: amountPaid, remaining_balance: remaining },
  });
}

export async function POST(request: Request, { params }: Params) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await params;
  const body = (await request.json()) as {
    action?: "pay" | "void";
    amount?: number;
    paymentDate?: string;
    memo?: string;
  };

  const { data: expense, error } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("kind", "expense")
    .eq("id", id)
    .maybeSingle();
  if (error || !expense) return jsonError("Expense not found", 404);

  if (body.action === "void") {
    if (expense.status === "void") {
      return NextResponse.json({ ok: true, alreadyVoid: true });
    }
    try {
      await voidExpense(supabase, {
        organizationId,
        documentId: id,
        number: expense.number,
        voidDate: todayISO(),
        postedEntryId: expense.posted_entry_id,
        currentStatus: expense.status as "draft" | "open" | "partially_paid" | "paid" | "void",
        actorId: session.userId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not void expense";
      return jsonError(message, 400);
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "pay") {
    if (expense.status === "void") {
      return jsonError("Cannot pay a void expense", 400);
    }
    if (expense.status === "paid") {
      return jsonError("Bill is already paid", 400);
    }

    const expenseTotal = asNumber(expense.total);
    const priorPaid = await resolveDocumentAmountPaid(
      supabase,
      organizationId,
      id,
      asNumber(expense.amount_paid),
    );

    try {
      const result = await postExpensePaid(supabase, {
        organizationId,
        documentId: id,
        partyId: expense.party_id,
        jobId: expense.job_id,
        issueDate: body.paymentDate || todayISO(),
        number: expense.number,
        paymentAmount: asNumber(body.amount),
        expenseTotal,
        priorPaid,
        paymentMemo: body.memo,
        actorId: session.userId,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not record payment";
      return jsonError(message, 400);
    }
  }

  return jsonError("Unknown action", 400);
}
