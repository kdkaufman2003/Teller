import { NextResponse } from "next/server";
import { reversePayment } from "@/lib/accounting/settlements";
import { todayISO } from "@/lib/format";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const { id } = await params;

  const { data: payment, error } = await supabase
    .from("teller_payments")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();

  if (error || !payment) return jsonError("Payment not found", 404);

  const { data: allocations } = await supabase
    .from("teller_payment_allocations")
    .select("id, document_id, amount, allocation_kind, reversed_by_allocation_id, created_at")
    .eq("organization_id", organizationId)
    .eq("payment_id", id)
    .order("created_at");

  return NextResponse.json({ payment, allocations: allocations ?? [] });
}

export async function POST(request: Request, { params }: Params) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await params;
  const body = (await request.json()) as {
    action?: "reverse";
    reversalDate?: string;
    reversalEventId?: string;
    reason?: string;
  };

  if (body.action !== "reverse") return jsonError("Unsupported action", 400);
  if (!body.reason?.trim()) return jsonError("Reason is required", 400);

  try {
    const result = await reversePayment(supabase, {
      organizationId,
      paymentId: id,
      reversalDate: body.reversalDate || todayISO(),
      reversalEventId: body.reversalEventId,
      reason: body.reason.trim(),
      actorId: session.userId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not reverse payment", 400);
  }
}
