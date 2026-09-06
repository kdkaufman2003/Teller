import { NextResponse } from "next/server";
import {
  postVendorCreditOpen,
  applyDocumentCredit,
  voidCreditDocument,
} from "@/lib/accounting/credits";
import { nextNumber } from "@/lib/accounting/accounts";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { asNumber, todayISO } from "@/lib/format";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data, error } = await supabase
    .from("teller_documents")
    .select("id, number, status, total, issue_date, memo, party_id, applies_to_document_id, job_id")
    .eq("organization_id", organizationId)
    .eq("kind", "vendor_credit")
    .order("issue_date", { ascending: false });

  if (error) return jsonError(error.message, 500);

  const { data: parties } = await supabase
    .from("teller_parties")
    .select("id, name")
    .eq("organization_id", organizationId);

  const partyNames = new Map((parties ?? []).map((row) => [row.id, row.name]));

  return NextResponse.json({
    vendorCredits: (data ?? []).map((row) => ({
      ...row,
      party_name: row.party_id ? partyNames.get(row.party_id) || "" : "",
    })),
  });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    partyId?: string;
    billId?: string;
    jobId?: string;
    issueDate?: string;
    reason?: string;
    memo?: string;
    tax?: number;
    post?: boolean;
    applyToBillId?: string;
    lines?: {
      description?: string;
      quantity?: number;
      unit_price?: number;
      accountId?: string;
    }[];
  };

  const lines = (body.lines || []).filter(
    (line) => line.description || asNumber(line.unit_price) > 0,
  );
  if (!lines.length) return jsonError("Add at least one line");
  if (!body.partyId) return jsonError("Vendor is required");

  const built = lines.map((line, index) => {
    const quantity = asNumber(line.quantity, 1);
    const unitPrice = asNumber(line.unit_price);
    const amount = quantity * unitPrice;
    return {
      description: line.description || "Line",
      quantity,
      unit_price: unitPrice,
      amount,
      account_id: line.accountId || null,
      item_type: "credit",
      sort_order: index,
    };
  });

  const subtotal = built.reduce((sum, line) => sum + line.amount, 0);
  const tax = asNumber(body.tax);
  const total = subtotal + tax;
  const issueDate = body.issueDate || todayISO();
  const appliesTo = body.billId || null;

  const { data: existing } = await supabase
    .from("teller_documents")
    .select("number")
    .eq("organization_id", organizationId)
    .eq("kind", "vendor_credit");
  const number = nextNumber(
    "VC",
    (existing ?? []).map((row) => row.number),
  );

  const metadata: Record<string, unknown> = {};
  if (body.reason) metadata.reason = body.reason;
  if (appliesTo) metadata.source_bill_id = appliesTo;

  const { data: doc, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: organizationId,
      kind: "vendor_credit",
      number,
      party_id: body.partyId,
      job_id: body.jobId || null,
      applies_to_document_id: appliesTo,
      status: "draft",
      issue_date: issueDate,
      subtotal,
      tax,
      total,
      memo: body.memo || body.reason || "",
      metadata,
    })
    .select("id")
    .single();

  if (error || !doc) return jsonError(error?.message || "Could not create vendor credit", 500);

  await supabase
    .from("teller_document_lines")
    .insert(built.map((line) => ({ ...line, document_id: doc.id })));

  await recordAuditEvent(supabase, {
    organizationId,
    actorId: session.userId,
    action: "vendor_credit.created",
    resourceKind: "vendor_credit",
    resourceId: doc.id,
    metadata: { number, total, appliesTo },
  });

  if (body.post !== false) {
    await postVendorCreditOpen(supabase, {
      organizationId,
      documentId: doc.id,
      partyId: body.partyId,
      jobId: body.jobId || null,
      issueDate,
      number,
      tax,
      reason: body.reason,
      lines: built,
      actorId: session.userId,
    });

    if (body.applyToBillId) {
      await applyDocumentCredit(supabase, {
        organizationId,
        sourceDocumentId: doc.id,
        targetDocumentId: body.applyToBillId,
        amount: total,
        actorId: session.userId,
      });
    }
  }

  return NextResponse.json({ id: doc.id, number });
}
