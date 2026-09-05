import { NextResponse } from "next/server";
import { nextNumber, revenueCodeForItemType } from "@/lib/accounting/accounts";
import { postInvoiceOpen, postInvoicePaid } from "@/lib/accounting/post";
import {
  collectTaxEnabled,
  readOrgAccountingConfig,
  resolveOrgTaxRate,
} from "@/lib/org/config";
import { asNumber, addDaysISO, todayISO } from "@/lib/format";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { buildTaxContextFromOrg } from "@/lib/tax/context";
import { determineInvoiceTax, persistTaxDeterminations } from "@/lib/tax/determine";
import type { TaxTransactionLine } from "@/lib/tax/types";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data, error } = await supabase
    .from("teller_documents")
    .select(
      "id, number, status, total, amount_paid, issue_date, due_date, memo, party_id, job_id, external_source",
    )
    .eq("organization_id", organizationId)
    .eq("kind", "invoice")
    .order("created_at", { ascending: false });

  if (error) return jsonError(error.message, 500);

  const [{ data: parties }, { data: jobs }] = await Promise.all([
    supabase.from("teller_parties").select("id, name").eq("organization_id", organizationId),
    supabase.from("teller_jobs").select("id, job_number, name").eq("organization_id", organizationId),
  ]);

  const partyNames = new Map((parties ?? []).map((row) => [row.id, row.name]));
  const jobNames = new Map(
    (jobs ?? []).map((row) => [row.id, `${row.job_number} · ${row.name}`]),
  );

  return NextResponse.json({
    invoices: (data ?? []).map((row) => ({
      ...row,
      party_name: row.party_id ? partyNames.get(row.party_id) || "" : "",
      job_name: row.job_id ? jobNames.get(row.job_id) || "" : "",
    })),
  });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    partyId?: string;
    jobId?: string;
    issueDate?: string;
    dueDate?: string;
    memo?: string;
    taxRate?: number;
    status?: "draft" | "open" | "paid";
    lines?: {
      description?: string;
      quantity?: number;
      unit_price?: number;
      item_type?: string;
    }[];
  };

  const lines = (body.lines || []).filter(
    (line) => line.description || asNumber(line.unit_price) > 0,
  );
  if (!lines.length) return jsonError("Add at least one line");

  const { data: accounts } = await supabase
    .from("teller_accounts")
    .select("id, code, type")
    .eq("organization_id", organizationId);

  const accountByCode = new Map((accounts ?? []).map((row) => [row.code, row.id]));

  const built = lines.map((line, index) => {
    const quantity = asNumber(line.quantity, 1);
    const unitPrice = asNumber(line.unit_price);
    const amount = quantity * unitPrice;
    const itemType = line.item_type || "other";
    const code = revenueCodeForItemType(itemType, accounts ?? []);
    return {
      description: line.description || "Line",
      quantity,
      unit_price: unitPrice,
      amount,
      item_type: itemType,
      account_id: accountByCode.get(code) ?? null,
      sort_order: index,
    };
  });

  const subtotal = built.reduce((sum, line) => sum + line.amount, 0);
  const accounting = readOrgAccountingConfig(session.settings?.answers);
  const orgTaxRate = resolveOrgTaxRate(session.settings?.answers);
  const issueDate = body.issueDate || todayISO();

  const taxLines: TaxTransactionLine[] = built.map((line, index) => ({
    lineKey: String(index),
    description: line.description,
    amount: line.amount,
    itemType: line.item_type,
  }));

  let tax = 0;
  let taxDeterminations = null;

  if (collectTaxEnabled(session.settings?.answers)) {
    const taxResult = await determineInvoiceTax(supabase, {
      mode: accounting.taxMode,
      taxRatePercent:
        body.taxRate !== undefined ? asNumber(body.taxRate) : orgTaxRate,
      transactionDate: issueDate,
      businessLocation: buildTaxContextFromOrg(session.organization ?? {}),
      lines: taxLines,
    });
    tax = taxResult.tax;
    taxDeterminations = taxResult.lines;
  }

  const total = subtotal + tax;

  const { data: existing } = await supabase
    .from("teller_documents")
    .select("number")
    .eq("organization_id", organizationId)
    .eq("kind", "invoice");
  const number = nextNumber(
    "INV",
    (existing ?? []).map((row) => row.number),
  );

  const { data: doc, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: organizationId,
      kind: "invoice",
      number,
      party_id: body.partyId || null,
      job_id: body.jobId || null,
      status: "draft",
      issue_date: issueDate,
      due_date: body.dueDate || addDaysISO(30, issueDate),
      subtotal,
      tax,
      total,
      memo: body.memo || "",
    })
    .select("id")
    .single();

  if (error || !doc) return jsonError(error?.message || "Could not create invoice", 500);

  const { data: insertedLines, error: lineError } = await supabase
    .from("teller_document_lines")
    .insert(built.map((line) => ({ ...line, document_id: doc.id })))
    .select("id");
  if (lineError) return jsonError(lineError.message, 500);

  if (taxDeterminations?.length) {
    await persistTaxDeterminations(supabase, {
      organizationId,
      documentId: doc.id,
      lineIds: (insertedLines ?? []).map((row) => row.id),
      determinations: taxDeterminations,
    });
  }

  if (body.status === "open" || body.status === "paid") {
    await postInvoiceOpen(supabase, {
      organizationId,
      documentId: doc.id,
      partyId: body.partyId || null,
      jobId: body.jobId || null,
      issueDate,
      number,
      tax,
      lines: built,
    });
  }
  if (body.status === "paid") {
    await postInvoicePaid(supabase, {
      organizationId,
      documentId: doc.id,
      partyId: body.partyId || null,
      jobId: body.jobId || null,
      issueDate,
      number,
      total,
    });
  }

  return NextResponse.json({ id: doc.id, number });
}
