import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { postAuthorityTaxPayment, resolveDefaultCashAccountId } from "@/lib/accounting/tax/payments";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data, error } = await supabase
    .from("teller_tax_authority_payments")
    .select(
      "id, payment_date, base_tax_amount, penalty_amount, interest_amount, total_amount, unapplied_amount, status, reference_number, registration_id, filing_period_id:jurisdiction_key",
    )
    .eq("organization_id", organizationId)
    .order("payment_date", { ascending: false })
    .limit(100);

  if (error) {
    if (/does not exist|schema cache|PGRST205/i.test(error.message)) {
      return jsonError("Tax authority payment schema is not available — apply migration 038 manually first", 503);
    }
    return jsonError(error.message, 400);
  }

  return NextResponse.json({ payments: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    registrationId?: string;
    paymentDate?: string;
    cashAccountId?: string;
    baseTaxAmount?: number;
    penaltyAmount?: number;
    interestAmount?: number;
    allocations?: Array<{ filingPeriodId: string; amount: number }>;
    referenceNumber?: string;
    memo?: string;
    idempotencyKey?: string;
  };

  if (!body.registrationId || !body.paymentDate) {
    return jsonError("registrationId and paymentDate are required", 400);
  }

  try {
    const cashAccountId =
      body.cashAccountId?.trim() || (await resolveDefaultCashAccountId(supabase, organizationId));
    const result = await postAuthorityTaxPayment(supabase, {
      organizationId,
      registrationId: body.registrationId,
      paymentDate: body.paymentDate,
      cashAccountId,
      baseTaxAmount: Number(body.baseTaxAmount ?? 0),
      penaltyAmount: body.penaltyAmount,
      interestAmount: body.interestAmount,
      allocations: body.allocations,
      referenceNumber: body.referenceNumber,
      memo: body.memo,
      idempotencyKey: body.idempotencyKey,
      actorId: session.userId,
    });
    return NextResponse.json({ payment: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not post tax authority payment";
    if (/does not exist|schema cache|PGRST205/i.test(message)) {
      return jsonError("Tax authority payment schema is not available — apply migration 038 manually first", 503);
    }
    return jsonError(message, 400);
  }
}
