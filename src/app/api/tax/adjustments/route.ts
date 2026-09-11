import { NextResponse } from "next/server";
import { jsonError, requireWriteBooks } from "@/lib/api";
import { postTaxManualAdjustment } from "@/lib/accounting/tax/payments";
import type { TaxManualAdjustmentDirection, TaxManualAdjustmentReasonCode } from "@/lib/accounting/tax/payments";

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    registrationId?: string;
    filingPeriodId?: string | null;
    adjustmentDate?: string;
    amount?: number;
    direction?: TaxManualAdjustmentDirection;
    reasonCode?: TaxManualAdjustmentReasonCode;
    reasonNotes?: string;
    offsetAccountId?: string;
    idempotencyKey?: string;
  };

  if (
    !body.registrationId ||
    !body.adjustmentDate ||
    !body.amount ||
    !body.direction ||
    !body.reasonCode ||
    !body.offsetAccountId
  ) {
    return jsonError("registrationId, adjustmentDate, amount, direction, reasonCode, and offsetAccountId are required", 400);
  }

  try {
    const result = await postTaxManualAdjustment(supabase, {
      organizationId,
      registrationId: body.registrationId,
      filingPeriodId: body.filingPeriodId ?? null,
      adjustmentDate: body.adjustmentDate,
      amount: Number(body.amount),
      direction: body.direction,
      reasonCode: body.reasonCode,
      reasonNotes: body.reasonNotes,
      offsetAccountId: body.offsetAccountId,
      idempotencyKey: body.idempotencyKey,
      actorId: session.userId,
    });
    return NextResponse.json({ adjustment: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not post tax adjustment";
    if (/does not exist|schema cache|PGRST205/i.test(message)) {
      return jsonError("Tax adjustment schema is not available — apply migration 038 manually first", 503);
    }
    return jsonError(message, 400);
  }
}
