import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { recordBankingAuditEvent } from "@/lib/banking/audit";
import { parseBankCsv } from "@/lib/banking/csv";
import { importBankTransactionsBatch } from "@/lib/banking/ingest";
import { MANUAL_CSV_PROVIDER, type CsvColumnMapping } from "@/lib/banking/types";

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const contentType = request.headers.get("content-type") ?? "";
  let bankAccountId = "";
  let action: "preview" | "confirm" = "preview";
  let mapping: CsvColumnMapping = { date: "" };
  let csvContent = "";
  let batchId: string | null = null;
  let filename: string | null = null;

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    bankAccountId = String(form.get("bankAccountId") ?? "");
    action = form.get("action") === "confirm" ? "confirm" : "preview";
    filename = form.get("filename") ? String(form.get("filename")) : null;
    batchId = form.get("batchId") ? String(form.get("batchId")) : null;
    mapping = {
      date: String(form.get("dateColumn") ?? ""),
      description: form.get("descriptionColumn")
        ? String(form.get("descriptionColumn"))
        : undefined,
      payee: form.get("payeeColumn") ? String(form.get("payeeColumn")) : undefined,
      memo: form.get("memoColumn") ? String(form.get("memoColumn")) : undefined,
      amount: form.get("amountColumn") ? String(form.get("amountColumn")) : undefined,
      debit: form.get("debitColumn") ? String(form.get("debitColumn")) : undefined,
      credit: form.get("creditColumn") ? String(form.get("creditColumn")) : undefined,
    };
    const file = form.get("file");
    if (file instanceof File) {
      csvContent = await file.text();
      filename = filename ?? file.name;
    } else {
      csvContent = String(form.get("content") ?? "");
    }
  } else {
    const body = (await request.json()) as {
      bankAccountId?: string;
      action?: "preview" | "confirm";
      content?: string;
      mapping?: CsvColumnMapping;
      batchId?: string;
      filename?: string;
    };
    bankAccountId = body.bankAccountId ?? "";
    action = body.action === "confirm" ? "confirm" : "preview";
    csvContent = body.content ?? "";
    mapping = body.mapping ?? { date: "" };
    batchId = body.batchId ?? null;
    filename = body.filename ?? null;
  }

  if (!bankAccountId) return jsonError("bankAccountId is required");
  if (!mapping.date) return jsonError("mapping.date is required");
  if (!csvContent && action === "preview") return jsonError("CSV content is required");

  const { data: bankAccount, error: accountError } = await supabase
    .from("teller_bank_accounts")
    .select("id, account_type, account_subtype")
    .eq("organization_id", organizationId)
    .eq("id", bankAccountId)
    .maybeSingle();

  if (accountError) return jsonError(accountError.message, 500);
  if (!bankAccount) return jsonError("Bank account not found", 404);

  try {
    if (action === "confirm") {
      if (!batchId) return jsonError("batchId is required for confirm");

      const { data: batch, error: batchError } = await supabase
        .from("teller_bank_import_batches")
        .select("id, mapping, status")
        .eq("organization_id", organizationId)
        .eq("id", batchId)
        .maybeSingle();

      if (batchError) return jsonError(batchError.message, 500);
      if (!batch) return jsonError("Import batch not found", 404);
      if (batch.status === "completed") {
        return NextResponse.json({ ok: true, duplicate: true, batchId });
      }

      const storedMapping = batch.mapping as CsvColumnMapping;
      const parsed = parseBankCsv({
        organizationId,
        bankAccountId,
        content: csvContent,
        mapping: storedMapping,
        bankAccountType: bankAccount.account_type,
        bankAccountSubtype: bankAccount.account_subtype,
      });

      const result = await importBankTransactionsBatch(supabase, {
        organizationId,
        bankAccountId,
        provider: MANUAL_CSV_PROVIDER,
        transactions: parsed.rows,
        importBatchId: batchId,
      }, { actorId: session.userId });

      await supabase
        .from("teller_bank_import_batches")
        .update({
          status: "completed",
          imported_count: result.imported,
          duplicate_count: result.duplicates,
          row_count: parsed.rows.length,
          completed_at: new Date().toISOString(),
        })
        .eq("id", batchId);

      await recordBankingAuditEvent(supabase, {
        organizationId,
        actorId: session.userId,
        action: "banking.csv_batch.imported",
        resourceKind: "bank_import_batch",
        resourceId: batchId,
        metadata: { ...result, rowCount: parsed.rows.length },
      });

      return NextResponse.json({ ok: true, batchId, result });
    }

    const parsed = parseBankCsv({
      organizationId,
      bankAccountId,
      content: csvContent,
      mapping,
      bankAccountType: bankAccount.account_type,
      bankAccountSubtype: bankAccount.account_subtype,
    });

    const { data: batch, error: batchError } = await supabase
      .from("teller_bank_import_batches")
      .insert({
        organization_id: organizationId,
        bank_account_id: bankAccountId,
        source: MANUAL_CSV_PROVIDER,
        filename,
        mapping,
        status: "preview",
        row_count: parsed.rows.length,
        created_by: session.userId,
      })
      .select("id")
      .single();

    if (batchError || !batch) {
      return jsonError(batchError?.message || "Could not create import batch", 500);
    }

    return NextResponse.json({
      batchId: batch.id,
      headers: parsed.headers,
      preview: parsed.rows.slice(0, 25),
      rowCount: parsed.rows.length,
      errors: parsed.errors,
      duplicates: parsed.duplicates,
      skipped: parsed.skipped,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CSV import failed";
    return jsonError(message, 500);
  }
}

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const url = new URL(request.url);
  const batchId = url.searchParams.get("batchId");
  if (!batchId) return jsonError("batchId is required");

  const { data, error } = await supabase
    .from("teller_bank_import_batches")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", batchId)
    .maybeSingle();

  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Import batch not found", 404);
  return NextResponse.json({ batch: data });
}
