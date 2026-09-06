import { NextResponse } from "next/server";
import {
  applyDepositToInvoice,
  authoritativeDepositRemaining,
  voidCustomerDeposit,
} from "@/lib/accounting/deposits";
import { sumDepositApplicationsForPayment } from "@/lib/accounting/deposits";
import { asNumber, todayISO } from "@/lib/format";
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
    .eq("payment_type", "customer_deposit")
    .maybeSingle();

  if (error || !payment) return jsonError("Deposit not found", 404);

  const amount = asNumber(payment.amount);
  const applied = await sumDepositApplicationsForPayment(supabase, organizationId, id);
  const remaining = await authoritativeDepositRemaining(
    supabase,
    organizationId,
    id,
    amount,
  );

  const { data: allocations } = await supabase
    .from("teller_payment_allocations")
    .select("id, document_id, amount, application_journal_entry_id, application_event_id, created_at")
    .eq("organization_id", organizationId)
    .eq("payment_id", id)
    .eq("allocation_kind", "deposit_apply")
    .order("created_at");

  const invoiceIds = [...new Set((allocations ?? []).map((row) => row.document_id as string))];
  const { data: invoices } = invoiceIds.length
    ? await supabase
        .from("teller_documents")
        .select("id, number")
        .eq("organization_id", organizationId)
        .in("id", invoiceIds)
    : { data: [] as { id: string; number: string }[] };

  const invoiceNumbers = new Map((invoices ?? []).map((row) => [row.id, row.number]));

  return NextResponse.json({
    deposit: {
      ...payment,
      applied,
      remaining,
      receiptJournalEntryId: payment.journal_entry_id,
    },
    applications: (allocations ?? []).map((row) => ({
      ...row,
      invoice_number: invoiceNumbers.get(row.document_id as string) || "",
    })),
  });
}

export async function POST(request: Request, { params }: Params) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await params;
  const body = (await request.json()) as {
    action?: "apply" | "void";
    invoiceId?: string;
    amount?: number;
    applicationDate?: string;
    applicationEventId?: string;
    memo?: string;
    reason?: string;
    voidDate?: string;
  };

  if (body.action === "apply") {
    if (!body.invoiceId) return jsonError("invoiceId is required", 400);
    try {
      const result = await applyDepositToInvoice(supabase, {
        organizationId,
        paymentId: id,
        invoiceId: body.invoiceId,
        amount: asNumber(body.amount),
        applicationDate: body.applicationDate || todayISO(),
        applicationEventId: body.applicationEventId,
        memo: body.memo,
        actorId: session.userId,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not apply deposit";
      return jsonError(message, 400);
    }
  }

  if (body.action === "void") {
    try {
      const result = await voidCustomerDeposit(supabase, {
        organizationId,
        paymentId: id,
        voidDate: body.voidDate || todayISO(),
        reason: body.reason,
        actorId: session.userId,
      });
      return NextResponse.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not void deposit";
      return jsonError(message, 400);
    }
  }

  return jsonError("Unknown action", 400);
}
