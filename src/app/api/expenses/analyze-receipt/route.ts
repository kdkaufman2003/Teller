import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import {
  classifyReceipt,
  isAllowedReceiptMime,
  MAX_RECEIPT_BYTES,
} from "@/lib/expenses/receipt-analyze";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError("Choose a receipt image or PDF");
  }

  if (!isAllowedReceiptMime(file.type)) {
    return jsonError("Use JPEG, PNG, WebP, HEIC, or PDF");
  }
  if (file.size > MAX_RECEIPT_BYTES) {
    return jsonError("Receipt must be 5 MB or smaller");
  }

  const { data: accounts, error: accountsError } = await supabase
    .from("teller_accounts")
    .select("id, code, name")
    .eq("organization_id", organizationId)
    .in("type", ["expense", "cogs"])
    .order("code");

  if (accountsError) return jsonError(accountsError.message, 500);
  if (!accounts?.length) return jsonError("No expense accounts found", 500);

  const buffer = Buffer.from(await file.arrayBuffer());
  const extension = file.name.includes(".") ? file.name.split(".").pop() : "jpg";
  const attachmentPath = `${organizationId}/pending/${crypto.randomUUID()}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from("receipts")
    .upload(attachmentPath, buffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    return jsonError(
      uploadError.message.includes("Bucket not found")
        ? "Receipt storage is not set up — run migration 003_expense_receipts.sql in Supabase"
        : uploadError.message,
      500,
    );
  }

  const { classification, readMethod, aiEnabled, notice } = await classifyReceipt(accounts, {
    buffer,
    mimeType: file.type,
    fileName: file.name,
  });

  return NextResponse.json({
    attachmentPath,
    classification,
    readMethod,
    aiEnabled,
    notice,
  });
}
