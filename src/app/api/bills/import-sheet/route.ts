import { NextResponse } from "next/server";
import { nextNumber } from "@/lib/accounting/accounts";
import { detectDuplicateBillWarnings } from "@/lib/accounting/duplicate-bills";
import {
  invoiceSheetMemo,
  sanitizeInvoiceSheetRows,
  type InvoiceSheetRow,
} from "@/lib/accounting/invoice-sheet";
import { invoiceSheetKind, readInvoiceSheet } from "@/lib/accounting/invoice-sheet-read";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { findOrCreateVendor } from "@/lib/expenses/find-vendor";
import { MAX_RECEIPT_BYTES } from "@/lib/expenses/receipt-analyze";
import { jsonError, requireWriteBooks } from "@/lib/api";

export const runtime = "nodejs";

const STORED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

async function preview(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return jsonError("Choose an invoice sheet");
  if (file.size > MAX_RECEIPT_BYTES) return jsonError("Invoice sheet must be 5 MB or smaller");
  if (!invoiceSheetKind(file.name, file.type)) {
    return jsonError("Upload a CSV, PDF, or screenshot (PNG, JPEG, or WebP).");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let rows: InvoiceSheetRow[];
  let notice: string | undefined;
  try {
    const read = await readInvoiceSheet({
      buffer,
      mimeType: file.type,
      fileName: file.name,
    });
    rows = read.rows;
    notice = read.notice;
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not read the invoice sheet");
  }

  let attachmentPath: string | null = null;
  const kind = invoiceSheetKind(file.name, file.type);
  const mimeType = STORED_MIME.has(file.type)
    ? file.type
    : kind === "pdf"
      ? "application/pdf"
      : kind === "image"
        ? "image/png"
        : "";
  if (mimeType) {
    const extension = file.name.includes(".") ? file.name.split(".").pop() : "bin";
    const path = `${organizationId}/invoice-sheets/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from("receipts").upload(path, buffer, {
      contentType: mimeType,
      upsert: false,
    });
    if (!uploadError) attachmentPath = path;
    else notice = notice || "The invoices were read, but the file could not be stored.";
  }

  return NextResponse.json({ rows, attachmentPath, notice });
}

async function commit(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    partyId?: string;
    vendorName?: string;
    accountId?: string;
    attachmentPath?: string | null;
    rows?: unknown;
  };

  const rows = sanitizeInvoiceSheetRows(body.rows).filter((row) => row.include && row.amount > 0);
  if (!rows.length) return jsonError("Choose at least one invoice with an amount.");

  const accountId = body.accountId?.trim();
  if (!accountId) return jsonError("Choose the account for these invoices.");
  const { data: account, error: accountError } = await supabase
    .from("teller_accounts")
    .select("id, type")
    .eq("organization_id", organizationId)
    .eq("id", accountId)
    .maybeSingle();
  if (accountError) return jsonError(accountError.message, 500);
  if (!account || !["expense", "cogs", "asset"].includes(account.type as string)) {
    return jsonError("Choose an expense, COGS, or asset account.");
  }

  let attachmentPath: string | null = null;
  if (typeof body.attachmentPath === "string" && body.attachmentPath.trim()) {
    const path = body.attachmentPath.trim();
    if (!path.startsWith(`${organizationId}/`) || path.includes("..")) {
      return jsonError("Invalid invoice sheet file");
    }
    attachmentPath = path;
  }

  let partyId: string | null;
  try {
    partyId = await findOrCreateVendor(supabase, organizationId, {
      partyId: body.partyId,
      vendorName: body.vendorName,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Choose the vendor this sheet is from.");
  }
  if (!partyId) return jsonError("Choose the vendor this sheet is from.");

  const { data: existing } = await supabase
    .from("teller_documents")
    .select("number")
    .eq("organization_id", organizationId)
    .eq("kind", "bill");
  const numbers = (existing ?? []).map((row) => row.number as string);

  const created: { id: string; number: string; reference: string }[] = [];
  const skipped: { reference: string; reason: string }[] = [];

  for (const row of rows) {
    if (!row.issueDate) {
      skipped.push({ reference: row.description, reason: "Add an invoice date." });
      continue;
    }

    const duplicateWarnings = await detectDuplicateBillWarnings(supabase, {
      organizationId,
      partyId,
      referenceNumber: row.reference,
      total: row.amount,
      issueDate: row.issueDate,
    });
    if (duplicateWarnings.length) {
      skipped.push({ reference: row.reference, reason: duplicateWarnings[0].message });
      continue;
    }

    const number = nextNumber("BILL", numbers);
    numbers.push(number);
    const { data: doc, error } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: organizationId,
        kind: "bill",
        number,
        party_id: partyId,
        status: "draft",
        issue_date: row.issueDate,
        due_date: row.issueDate,
        subtotal: row.amount,
        tax: 0,
        total: row.amount,
        memo: invoiceSheetMemo(row),
        reference_number: row.reference,
        terms: "",
        attachment_path: attachmentPath,
        metadata: {
          import_source: "invoice_sheet",
          sheet_status: row.status,
          period: row.period,
        },
      })
      .select("id")
      .single();

    if (error || !doc) {
      skipped.push({
        reference: row.reference,
        reason: error?.message || "Could not save this invoice",
      });
      continue;
    }

    const { error: lineError } = await supabase.from("teller_document_lines").insert({
      document_id: doc.id,
      description: row.description,
      quantity: 1,
      unit_price: row.amount,
      amount: row.amount,
      account_id: accountId,
      job_id: null,
      cost_category: "",
      cost_type: "",
      cost_classification: "direct",
      item_type: "expense",
      sort_order: 0,
    });
    if (lineError) {
      skipped.push({ reference: row.reference, reason: lineError.message });
      continue;
    }

    await recordAuditEvent(supabase, {
      organizationId,
      actorId: session.userId,
      action: "bill.created",
      resourceKind: "bill",
      resourceId: doc.id,
      metadata: { number, total: row.amount, importSource: "invoice_sheet" },
    });
    created.push({ id: doc.id, number, reference: row.reference });
  }

  return NextResponse.json({ created, skipped });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return commit(request);
  return preview(request);
}
