import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import {
  linkAuthorityTaxPaymentToBankTransaction,
  reverseAuthorityTaxPayment,
} from "@/lib/accounting/tax/payments";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const { id } = await params;

  const { data: payment, error } = await supabase
    .from("teller_tax_authority_payments")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) return jsonError(error.message, 400);
  if (!payment) return jsonError("Tax authority payment not found", 404);

  const { data: allocations } = await supabase
    .from("teller_tax_authority_payment_allocations")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("authority_payment_id", id);

  return NextResponse.json({ payment, allocations: allocations ?? [] });
}

export async function POST(request: Request, { params }: Params) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await params;
  const body = (await request.json()) as {
    action?: "reverse" | "bank_match";
    reversalDate?: string;
    memo?: string;
    bankTransactionId?: string;
    clearedAmount?: number;
    clearedDate?: string;
  };

  try {
    if (body.action === "reverse") {
      if (!body.reversalDate) return jsonError("reversalDate is required", 400);
      const result = await reverseAuthorityTaxPayment(supabase, {
        organizationId,
        paymentId: id,
        reversalDate: body.reversalDate,
        memo: body.memo,
        actorId: session.userId,
      });
      return NextResponse.json({ reversal: result });
    }

    if (body.action === "bank_match") {
      if (!body.bankTransactionId || !body.clearedDate) {
        return jsonError("bankTransactionId and clearedDate are required", 400);
      }
      const result = await linkAuthorityTaxPaymentToBankTransaction(supabase, {
        organizationId,
        paymentId: id,
        bankTransactionId: body.bankTransactionId,
        clearedAmount: Number(body.clearedAmount ?? 0),
        clearedDate: body.clearedDate,
        actorId: session.userId,
      });
      return NextResponse.json({ match: result });
    }

    return jsonError("Unsupported action", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not update tax authority payment", 400);
  }
}
