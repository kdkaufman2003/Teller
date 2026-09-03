import { NextResponse } from "next/server";
import { nextNumber } from "@/lib/accounting/accounts";
import { postExpense } from "@/lib/accounting/post";
import { asNumber, todayISO } from "@/lib/format";
import { jsonError, requireBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data, error } = await supabase
    .from("teller_documents")
    .select("id, number, status, total, issue_date, memo, party_id")
    .eq("organization_id", organizationId)
    .eq("kind", "expense")
    .order("issue_date", { ascending: false });

  if (error) return jsonError(error.message, 500);

  const { data: parties } = await supabase
    .from("teller_parties")
    .select("id, name")
    .eq("organization_id", organizationId);

  const names = new Map((parties ?? []).map((row) => [row.id, row.name]));
  return NextResponse.json({
    expenses: (data ?? []).map((row) => ({
      ...row,
      party_name: row.party_id ? names.get(row.party_id) || "" : "",
    })),
  });
}

export async function POST(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const body = (await request.json()) as {
    vendorName?: string;
    partyId?: string;
    jobId?: string;
    accountId?: string;
    amount?: number;
    memo?: string;
    issueDate?: string;
    paid?: boolean;
  };

  const amount = asNumber(body.amount);
  if (amount <= 0) return jsonError("Amount must be greater than zero");
  if (!body.accountId) return jsonError("Choose an expense account");

  let partyId = body.partyId || null;
  if (!partyId && body.vendorName?.trim()) {
    const { data: vendor, error } = await supabase
      .from("teller_parties")
      .insert({
        organization_id: organizationId,
        kind: "vendor",
        name: body.vendorName.trim(),
      })
      .select("id")
      .single();
    if (error) return jsonError(error.message, 500);
    partyId = vendor.id;
  }

  const { data: existing } = await supabase
    .from("teller_documents")
    .select("number")
    .eq("organization_id", organizationId)
    .eq("kind", "expense");
  const number = nextNumber(
    "EXP",
    (existing ?? []).map((row) => row.number),
  );
  const issueDate = body.issueDate || todayISO();

  const { data: doc, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: organizationId,
      kind: "expense",
      number,
      party_id: partyId,
      job_id: body.jobId || null,
      status: "draft",
      issue_date: issueDate,
      subtotal: amount,
      tax: 0,
      total: amount,
      memo: body.memo || "",
    })
    .select("id")
    .single();

  if (error || !doc) return jsonError(error?.message || "Could not create expense", 500);

  await supabase.from("teller_document_lines").insert({
    document_id: doc.id,
    description: body.memo || "Expense",
    quantity: 1,
    unit_price: amount,
    amount,
    account_id: body.accountId,
    item_type: "expense",
  });

  await postExpense(supabase, {
    organizationId,
    documentId: doc.id,
    partyId,
    jobId: body.jobId || null,
    issueDate,
    number,
    amount,
    accountId: body.accountId,
    paid: body.paid !== false,
  });

  return NextResponse.json({ id: doc.id, number });
}
