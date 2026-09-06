import { NextResponse } from "next/server";
import {
  documentRemainingBalance,
  resolveDocumentAmountPaid,
} from "@/lib/accounting/balances";
import { postInvoiceOpen, postInvoicePaid, voidInvoice } from "@/lib/accounting/post";
import { writeOffInvoice } from "@/lib/accounting/settlements";
import { asNumber, todayISO } from "@/lib/format";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const { id } = await params;

  const { data: invoice, error } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();

  if (error || !invoice) return jsonError("Invoice not found", 404);

  const { data: lines } = await supabase
    .from("teller_document_lines")
    .select("*")
    .eq("document_id", id)
    .order("sort_order");

  const amountPaid = await resolveDocumentAmountPaid(
    supabase,
    organizationId,
    id,
    asNumber(invoice.amount_paid),
  );
  const remaining = documentRemainingBalance(invoice.total, amountPaid);

  return NextResponse.json({
    invoice: { ...invoice, amount_paid: amountPaid, remaining_balance: remaining },
    lines: lines ?? [],
  });
}

export async function POST(request: Request, { params }: Params) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await params;
  const body = (await request.json()) as {
    action?: "open" | "pay" | "paid" | "void" | "writeoff";
    amount?: number;
    paymentDate?: string;
    memo?: string;
    reason?: string;
    writeoffDate?: string;
    writeoffEventId?: string;
  };

  const { data: invoice, error } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error || !invoice) return jsonError("Invoice not found", 404);

  if (body.action === "void") {
    if (invoice.status === "void") {
      return NextResponse.json({ ok: true, alreadyVoid: true });
    }
    if (invoice.status === "draft") {
      await supabase
        .from("teller_documents")
        .update({ status: "void", updated_at: new Date().toISOString() })
        .eq("id", id);
      return NextResponse.json({ ok: true });
    }
    try {
      await voidInvoice(supabase, {
        organizationId,
        documentId: id,
        number: invoice.number,
        voidDate: todayISO(),
        postedEntryId: invoice.posted_entry_id,
        currentStatus: invoice.status as "draft" | "open" | "partially_paid" | "paid" | "void",
        actorId: session.userId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not void invoice";
      return jsonError(message, 400);
    }
    return NextResponse.json({ ok: true });
  }

  const { data: lines } = await supabase
    .from("teller_document_lines")
    .select("amount, account_id, description, job_id, cost_classification")
    .eq("document_id", id);

  if (body.action === "open" && invoice.status === "draft") {
    await postInvoiceOpen(supabase, {
      organizationId,
      documentId: id,
      partyId: invoice.party_id,
      jobId: invoice.job_id,
      issueDate: invoice.issue_date,
      number: invoice.number,
      tax: asNumber(invoice.tax),
      lines: lines ?? [],
    });
  }

  if (body.action === "pay" || body.action === "paid") {
    if (invoice.status === "void") {
      return jsonError("Cannot pay a void invoice", 400);
    }
    if (invoice.status === "paid") {
      return jsonError("Invoice is already paid", 400);
    }

    if (invoice.status === "draft") {
      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: id,
        partyId: invoice.party_id,
        jobId: invoice.job_id,
        issueDate: invoice.issue_date,
        number: invoice.number,
        tax: asNumber(invoice.tax),
        lines: lines ?? [],
      });
    }

    const invoiceTotal = asNumber(invoice.total);
    const priorPaid = await resolveDocumentAmountPaid(
      supabase,
      organizationId,
      id,
      asNumber(invoice.amount_paid),
    );
    const remaining = documentRemainingBalance(invoiceTotal, priorPaid);

    const paymentAmount =
      body.action === "pay"
        ? asNumber(body.amount)
        : remaining;

    if (remaining <= 0.009) {
      return jsonError("Nothing left to pay on this invoice", 400);
    }

    try {
      const result = await postInvoicePaid(supabase, {
        organizationId,
        documentId: id,
        partyId: invoice.party_id,
        jobId: invoice.job_id,
        issueDate: body.paymentDate || todayISO(),
        number: invoice.number,
        total: paymentAmount,
        invoiceTotal,
        priorPaid,
        paymentMemo: body.memo,
        actorId: session.userId,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not record payment";
      return jsonError(message, 400);
    }
  }

  if (body.action === "writeoff") {
    if (!body.reason?.trim()) return jsonError("Write-off reason is required", 400);
    try {
      const result = await writeOffInvoice(supabase, {
        organizationId,
        invoiceId: id,
        amount: asNumber(body.amount),
        writeoffDate: body.writeoffDate || todayISO(),
        writeoffEventId: body.writeoffEventId,
        reason: body.reason.trim(),
        actorId: session.userId,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Could not write off invoice", 400);
    }
  }

  return NextResponse.json({ ok: true });
}
