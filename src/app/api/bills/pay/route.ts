import { NextResponse } from "next/server";
import { postMultiBillPayment } from "@/lib/accounting/bill-pay";
import { jsonError, requireWriteBooks } from "@/lib/api";

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const body = (await request.json()) as {
    partyId?: string;
    paymentDate?: string;
    referenceNumber?: string;
    paymentMethod?: string;
    memo?: string;
    allocations?: Array<{ documentId: string; amount: number }>;
    creditApplications?: Array<{
      sourceDocumentId: string;
      targetDocumentId: string;
      amount: number;
    }>;
    idempotencyKey?: string;
  };

  if (!body.partyId) return jsonError("Vendor is required");
  if (!body.allocations?.length) return jsonError("Select at least one bill");

  try {
    const result = await postMultiBillPayment(ctx.supabase, {
      organizationId: ctx.organizationId,
      partyId: body.partyId,
      paymentDate: body.paymentDate || new Date().toISOString().slice(0, 10),
      referenceNumber: body.referenceNumber,
      paymentMethod: body.paymentMethod,
      memo: body.memo,
      allocations: body.allocations,
      creditApplications: body.creditApplications,
      actorId: ctx.session.userId,
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Payment failed", 400);
  }
}
