import { NextResponse } from "next/server";
import {
  authoritativeDocumentRemaining,
  authoritativeDocumentSettled,
  resolveDocumentAmountPaid,
} from "@/lib/accounting/balances";
import { postBillPaid, voidBill, postBillOpen } from "@/lib/accounting/bills";
import { asNumber, todayISO } from "@/lib/format";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const { id } = await params;

  const { data: bill, error } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("kind", "bill")
    .eq("id", id)
    .maybeSingle();

  if (error || !bill) return jsonError("Bill not found", 404);

  const settled = await authoritativeDocumentSettled(supabase, organizationId, id);
  const remaining = await authoritativeDocumentRemaining(
    supabase,
    organizationId,
    id,
    asNumber(bill.total),
  );

  const [{ data: lines }, { data: payments }, { data: creditAllocations }] =
    await Promise.all([
      supabase
        .from("teller_document_lines")
        .select("*")
        .eq("document_id", id)
        .order("sort_order"),
      supabase
        .from("teller_payments")
        .select("id, amount, payment_date, payment_method, reference_number, status")
        .eq("organization_id", organizationId)
        .eq("document_id", id)
        .order("payment_date", { ascending: false }),
      supabase
        .from("teller_document_allocations")
        .select("id, amount, source_document_id, created_at")
        .eq("organization_id", organizationId)
        .eq("target_document_id", id),
    ]);

  return NextResponse.json({
    bill: {
      ...bill,
      amount_paid: settled.payments,
      credits_applied: settled.credits,
      remaining_balance: remaining,
    },
    lines: lines ?? [],
    payments: payments ?? [],
    creditAllocations: creditAllocations ?? [],
  });
}

export async function POST(request: Request, { params }: Params) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await params;
  const body = (await request.json()) as {
    action?: "post" | "pay" | "void";
    amount?: number;
    paymentDate?: string;
    memo?: string;
    paymentMethod?: string;
    referenceNumber?: string;
  };

  const { data: bill, error } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("kind", "bill")
    .eq("id", id)
    .maybeSingle();
  if (error || !bill) return jsonError("Bill not found", 404);

  if (body.action === "post") {
    if (bill.status !== "draft") return jsonError("Only draft bills can be posted", 400);
    const { data: lines } = await supabase
      .from("teller_document_lines")
      .select("amount, account_id, description")
      .eq("document_id", id);
    try {
      await postBillOpen(supabase, {
        organizationId,
        documentId: id,
        partyId: bill.party_id,
        jobId: bill.job_id,
        issueDate: bill.issue_date,
        number: bill.number,
        tax: asNumber(bill.tax),
        lines: (lines ?? []).map((line) => ({
          amount: asNumber(line.amount),
          account_id: line.account_id,
          description: line.description,
        })),
        actorId: session.userId,
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Could not post bill", 400);
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "void") {
    if (bill.status === "void") return NextResponse.json({ ok: true, alreadyVoid: true });
    try {
      await voidBill(supabase, {
        organizationId,
        documentId: id,
        number: bill.number,
        voidDate: todayISO(),
        postedEntryId: bill.posted_entry_id,
        currentStatus: bill.status as "draft" | "open" | "partially_paid" | "paid" | "void",
        actorId: session.userId,
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Could not void bill", 400);
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "pay") {
    if (bill.status === "void") return jsonError("Cannot pay a void bill", 400);
    if (bill.status === "paid") return jsonError("Bill is already paid", 400);
    if (bill.status === "draft") return jsonError("Post the bill before recording payment", 400);

    const billTotal = asNumber(bill.total);
    const priorPaid = await resolveDocumentAmountPaid(
      supabase,
      organizationId,
      id,
      asNumber(bill.amount_paid),
    );

    try {
      const result = await postBillPaid(supabase, {
        organizationId,
        documentId: id,
        partyId: bill.party_id,
        jobId: bill.job_id,
        issueDate: body.paymentDate || todayISO(),
        number: bill.number,
        paymentAmount: asNumber(body.amount),
        billTotal,
        priorPaid,
        paymentMemo: body.memo,
        paymentMethod: body.paymentMethod,
        referenceNumber: body.referenceNumber,
        actorId: session.userId,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Could not record payment", 400);
    }
  }

  return jsonError("Unknown action", 400);
}
