import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { createBankTransfer, suggestTransferPairsForOrg } from "@/lib/banking/transfer";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const url = new URL(request.url);
  const bankAccountId = url.searchParams.get("bankAccountId");

  try {
    const pairs = await suggestTransferPairsForOrg(
      supabase,
      organizationId,
      bankAccountId,
    );
    return NextResponse.json({ pairs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not suggest transfers";
    return jsonError(message, 500);
  }
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    sourceBankTransactionId?: string;
    destinationBankTransactionId?: string;
    amount?: number;
    transferDate?: string;
    idempotencyEventId?: string | null;
  };

  if (!body.sourceBankTransactionId || !body.destinationBankTransactionId) {
    return jsonError("sourceBankTransactionId and destinationBankTransactionId are required");
  }
  if (!body.amount || !body.transferDate) {
    return jsonError("amount and transferDate are required");
  }

  try {
    const result = await createBankTransfer(supabase, {
      organizationId,
      sourceBankTransactionId: body.sourceBankTransactionId,
      destinationBankTransactionId: body.destinationBankTransactionId,
      amount: body.amount,
      transferDate: body.transferDate,
      idempotencyEventId: body.idempotencyEventId,
      actorId: session.userId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transfer failed";
    return jsonError(message, 500);
  }
}
