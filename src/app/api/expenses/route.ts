import { NextResponse } from "next/server";
import { nextNumber } from "@/lib/accounting/accounts";
import { postExpense } from "@/lib/accounting/post";
import {
  findMileageAccount,
  mileageAmount,
  roundMoney,
} from "@/lib/expenses/classify";
import { asNumber, todayISO } from "@/lib/format";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

type ExpenseType = "receipt" | "mileage" | "manual";

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
  const ctx = await requireWriteBooks();
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
    dueDate?: string;
    paid?: boolean;
    expenseType?: ExpenseType;
    attachmentPath?: string;
    miles?: number;
    ratePerMile?: number;
    classification?: Record<string, unknown>;
  };

  const expenseType: ExpenseType = body.expenseType || "manual";
  let amount = asNumber(body.amount);
  let accountId = body.accountId || "";
  let memo = body.memo || "";
  const metadata: Record<string, unknown> = { expense_type: expenseType };

  if (expenseType === "mileage") {
    const miles = asNumber(body.miles);
    const ratePerMile = asNumber(body.ratePerMile, 0.7);
    if (miles <= 0) return jsonError("Miles must be greater than zero");

    const { data: accounts } = await supabase
      .from("teller_accounts")
      .select("id, code, name")
      .eq("organization_id", organizationId)
      .in("type", ["expense", "cogs"])
      .order("code");

    const mileageAccount = findMileageAccount(accounts ?? []);
    if (!mileageAccount) return jsonError("No mileage expense account found");

    accountId = mileageAccount.id;
    amount = mileageAmount(miles, ratePerMile);
    metadata.miles = miles;
    metadata.rate_per_mile = ratePerMile;
    if (!memo) memo = `Mileage: ${miles} mi @ $${ratePerMile.toFixed(2)}/mi`;
  }

  amount = roundMoney(amount);
  if (amount <= 0) return jsonError("Amount must be greater than zero");
  if (!accountId) return jsonError("Choose an expense account");

  if (body.classification) {
    metadata.classification = body.classification;
  }

  let attachmentPath = body.attachmentPath?.trim() || null;
  if (attachmentPath && !attachmentPath.startsWith(`${organizationId}/`)) {
    return jsonError("Invalid receipt attachment");
  }

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
  const paid = body.paid !== false;
  const dueDate = !paid ? body.dueDate || issueDate : null;

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
      due_date: dueDate,
      subtotal: amount,
      tax: 0,
      total: amount,
      memo,
      attachment_path: attachmentPath,
      metadata,
    })
    .select("id")
    .single();

  if (error || !doc) return jsonError(error?.message || "Could not create expense", 500);

  await supabase.from("teller_document_lines").insert({
    document_id: doc.id,
    description: memo || "Expense",
    quantity: 1,
    unit_price: amount,
    amount,
    account_id: accountId,
    item_type: expenseType === "mileage" ? "mileage" : "expense",
  });

  if (attachmentPath?.includes("/pending/")) {
    const finalizedPath = `${organizationId}/${doc.id}/${attachmentPath.split("/").pop()}`;
    const { error: moveError } = await supabase.storage
      .from("receipts")
      .move(attachmentPath, finalizedPath);
    if (!moveError) {
      attachmentPath = finalizedPath;
      await supabase
        .from("teller_documents")
        .update({ attachment_path: finalizedPath })
        .eq("id", doc.id);
    }
  }

  await postExpense(supabase, {
    organizationId,
    documentId: doc.id,
    partyId,
    jobId: body.jobId || null,
    issueDate,
    number,
    amount,
    accountId,
    paid,
  });

  return NextResponse.json({ id: doc.id, number });
}
