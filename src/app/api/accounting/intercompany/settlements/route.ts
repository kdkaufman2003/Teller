import { NextResponse } from "next/server";
import {
  autoApplySettlementAllocations,
  listIntercompanySettlements,
  postIntercompanySettlement,
} from "@/lib/accounting/intercompany/settlement";
import { jsonError, requireAccountingBooks, requireAccountingWriteBooks } from "@/lib/api";
import type { ProfileRole } from "@/types";

export async function GET(request: Request) {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId } = ctx;

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);

  try {
    const rows = await listIntercompanySettlements(supabase, {
      organizationId,
      legalEntityId,
      limit,
    });
    return NextResponse.json({ settlements: rows });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not list settlements", 400);
  }
}

type PostBody = {
  payerLegalEntityId: string;
  payeeLegalEntityId: string;
  settlementDate: string;
  amount: number;
  reference?: string;
  memo?: string;
  allocations?: Array<{ intercompanyTransactionId: string; amountApplied: number }>;
  autoApply?: boolean;
  payerBankAccountId?: string;
  payeeBankAccountId?: string;
  settlementMode?: "itemized" | "net";
  idempotencyKey?: string;
};

export async function POST(request: Request) {
  const ctx = await requireAccountingWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session, auth } = ctx;
  if (!auth) return jsonError("Unauthorized", 401);

  const body = (await request.json()) as PostBody;
  const settlementDate = String(body.settlementDate ?? "").slice(0, 10);
  const amount = Number(body.amount);
  if (!settlementDate) return jsonError("settlementDate is required", 400);
  if (!Number.isFinite(amount) || amount <= 0) return jsonError("amount must be positive", 400);
  if (!body.payerLegalEntityId || !body.payeeLegalEntityId) {
    return jsonError("payerLegalEntityId and payeeLegalEntityId are required", 400);
  }

  const authCtx = { userId: auth.userId, role: auth.role as ProfileRole };

  try {
    let allocations = (body.allocations ?? []).map((row) => ({
      intercompanyTransactionId: row.intercompanyTransactionId,
      amountApplied: Number(row.amountApplied),
    }));

    if (body.autoApply) {
      allocations = await autoApplySettlementAllocations(supabase, {
        organizationId,
        payerLegalEntityId: body.payerLegalEntityId,
        payeeLegalEntityId: body.payeeLegalEntityId,
        amount,
        asOf: settlementDate,
      });
    }

    if (!allocations.length) {
      return jsonError("allocations are required (or set autoApply=true)", 400);
    }

    const result = await postIntercompanySettlement(supabase, {
      organizationId,
      payerLegalEntityId: body.payerLegalEntityId,
      payeeLegalEntityId: body.payeeLegalEntityId,
      settlementDate,
      amount,
      reference: body.reference,
      memo: body.memo,
      allocations,
      payerBankAccountId: body.payerBankAccountId,
      payeeBankAccountId: body.payeeBankAccountId,
      settlementMode: body.settlementMode,
      idempotencyKey: body.idempotencyKey,
      actorId: session.userId,
      auth: authCtx,
    });

    return NextResponse.json({ ...result, allocations });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not post settlement", 400);
  }
}
