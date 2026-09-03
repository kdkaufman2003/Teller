import { NextResponse } from "next/server";
import { postInvoiceOpen, postInvoicePaid } from "@/lib/accounting/post";
import { asNumber } from "@/lib/format";
import { jsonError, requireBooks } from "@/lib/api";

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

  return NextResponse.json({ invoice, lines: lines ?? [] });
}

export async function POST(request: Request, { params }: Params) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const { id } = await params;
  const body = (await request.json()) as { action?: "open" | "paid" | "void" };

  const { data: invoice, error } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error || !invoice) return jsonError("Invoice not found", 404);

  if (body.action === "void") {
    await supabase
      .from("teller_documents")
      .update({ status: "void", updated_at: new Date().toISOString() })
      .eq("id", id);
    return NextResponse.json({ ok: true });
  }

  const { data: lines } = await supabase
    .from("teller_document_lines")
    .select("amount, account_id, description")
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

  if (body.action === "paid") {
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
    if (invoice.status !== "paid") {
      await postInvoicePaid(supabase, {
        organizationId,
        documentId: id,
        partyId: invoice.party_id,
        jobId: invoice.job_id,
        issueDate: invoice.issue_date,
        number: invoice.number,
        total: asNumber(invoice.total),
      });
    }
  }

  return NextResponse.json({ ok: true });
}
