import { NextResponse } from "next/server";
import {
  listIntercompanyTransactions,
  postCashReceivedOnBehalf,
  postExpenseOnBehalf,
  postIntercompanyFundTransfer,
  postIntercompanyTransaction,
} from "@/lib/accounting/intercompany";
import type { IntercompanyTransactionType } from "@/lib/accounting/intercompany";
import { jsonError, requireAccountingBooks, requireAccountingWriteBooks } from "@/lib/api";
import type { ProfileRole } from "@/types";

export async function GET(request: Request) {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId } = ctx;

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);

  try {
    const rows = await listIntercompanyTransactions(supabase, {
      organizationId,
      legalEntityId,
      limit,
    });
    return NextResponse.json({ transactions: rows });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not list intercompany transactions", 400);
  }
}

type PostBody = {
  transactionType: IntercompanyTransactionType;
  sourceLegalEntityId: string;
  counterpartyLegalEntityId: string;
  entryDate: string;
  amount: number;
  description: string;
  reference?: string;
  idempotencyKey?: string;
  sourcePaymentAccountId?: string;
  counterpartyExpenseAccountId?: string;
  sourceCashAccountId?: string;
  counterpartyCashAccountId?: string;
  counterpartyCreditAccountId?: string;
  sourceLines?: Array<{ accountId: string; debit?: number; credit?: number; memo?: string }>;
  counterpartyLines?: Array<{ accountId: string; debit?: number; credit?: number; memo?: string }>;
};

export async function POST(request: Request) {
  const ctx = await requireAccountingWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session, auth } = ctx;
  if (!auth) return jsonError("Unauthorized", 401);

  const body = (await request.json()) as PostBody;
  const entryDate = String(body.entryDate ?? "").slice(0, 10);
  const amount = Number(body.amount);
  if (!entryDate) return jsonError("entryDate is required", 400);
  if (!Number.isFinite(amount) || amount <= 0) return jsonError("amount must be positive", 400);
  if (!body.sourceLegalEntityId || !body.counterpartyLegalEntityId) {
    return jsonError("sourceLegalEntityId and counterpartyLegalEntityId are required", 400);
  }
  if (!body.description?.trim()) return jsonError("description is required", 400);

  const authCtx = { userId: auth.userId, role: auth.role as ProfileRole };
  const common = {
    organizationId,
    sourceLegalEntityId: body.sourceLegalEntityId,
    counterpartyLegalEntityId: body.counterpartyLegalEntityId,
    entryDate,
    amount,
    description: body.description.trim(),
    idempotencyKey: body.idempotencyKey,
    actorId: session.userId,
    auth: authCtx,
  };

  try {
    let result;
    switch (body.transactionType) {
      case "expense_on_behalf":
        if (!body.sourcePaymentAccountId || !body.counterpartyExpenseAccountId) {
          return jsonError("sourcePaymentAccountId and counterpartyExpenseAccountId are required", 400);
        }
        result = await postExpenseOnBehalf(supabase, {
          ...common,
          sourcePaymentAccountId: body.sourcePaymentAccountId,
          counterpartyExpenseAccountId: body.counterpartyExpenseAccountId,
        });
        break;
      case "cash_received_on_behalf":
        if (!body.sourceCashAccountId || !body.counterpartyCreditAccountId) {
          return jsonError("sourceCashAccountId and counterpartyCreditAccountId are required", 400);
        }
        result = await postCashReceivedOnBehalf(supabase, {
          ...common,
          sourceCashAccountId: body.sourceCashAccountId,
          counterpartyCreditAccountId: body.counterpartyCreditAccountId,
        });
        break;
      case "fund_transfer":
        if (!body.sourceCashAccountId || !body.counterpartyCashAccountId) {
          return jsonError("sourceCashAccountId and counterpartyCashAccountId are required", 400);
        }
        result = await postIntercompanyFundTransfer(supabase, {
          ...common,
          sourceCashAccountId: body.sourceCashAccountId,
          counterpartyCashAccountId: body.counterpartyCashAccountId,
        });
        break;
      case "manual":
        if (!body.sourceLines?.length || !body.counterpartyLines?.length) {
          return jsonError("sourceLines and counterpartyLines are required for manual intercompany", 400);
        }
        result = await postIntercompanyTransaction(supabase, {
          ...common,
          transactionType: "manual",
          sourceLines: body.sourceLines,
          counterpartyLines: body.counterpartyLines,
          reference: body.reference,
        });
        break;
      default:
        return jsonError("Unsupported transactionType", 400);
    }
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not post intercompany transaction", 400);
  }
}
