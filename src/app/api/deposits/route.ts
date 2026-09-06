import { NextResponse } from "next/server";
import { receiveCustomerDeposit, batchDepositRemainingForPayments } from "@/lib/accounting/deposits";
import { asNumber } from "@/lib/format";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const url = new URL(request.url);
  const partyId = url.searchParams.get("partyId");

  let query = supabase
    .from("teller_payments")
    .select(
      "id, party_id, job_id, amount, payment_date, payment_method, reference_number, status, metadata, journal_entry_id",
    )
    .eq("organization_id", organizationId)
    .eq("payment_type", "customer_deposit")
    .order("payment_date", { ascending: false });

  if (partyId) query = query.eq("party_id", partyId);

  const { data, error } = await query;
  if (error) return jsonError(error.message, 500);

  const rows = data ?? [];
  const remainingMap = await batchDepositRemainingForPayments(
    supabase,
    organizationId,
    rows.map((row) => ({ id: row.id as string, amount: asNumber(row.amount) })),
  );

  const { data: parties } = await supabase
    .from("teller_parties")
    .select("id, name")
    .eq("organization_id", organizationId);

  const partyNames = new Map((parties ?? []).map((row) => [row.id, row.name]));

  return NextResponse.json({
    deposits: rows.map((row) => {
      const amount = asNumber(row.amount);
      const remaining = remainingMap.get(row.id as string) ?? amount;
      return {
        ...row,
        party_name: row.party_id ? partyNames.get(row.party_id) || "" : "",
        applied: amount - remaining,
        remaining,
      };
    }),
  });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    partyId?: string;
    jobId?: string;
    amount?: number;
    paymentDate?: string;
    paymentMethod?: string;
    referenceNumber?: string;
    memo?: string;
    externalSource?: string;
    externalId?: string;
    receiptEventId?: string;
  };

  if (!body.partyId) return jsonError("Customer is required", 400);

  try {
    const result = await receiveCustomerDeposit(supabase, {
      organizationId,
      partyId: body.partyId,
      jobId: body.jobId || null,
      amount: asNumber(body.amount),
      paymentDate: body.paymentDate || new Date().toISOString().slice(0, 10),
      paymentMethod: body.paymentMethod,
      referenceNumber: body.referenceNumber,
      memo: body.memo,
      externalSource: body.externalSource || null,
      externalId: body.externalId || null,
      receiptEventId: body.receiptEventId,
      actorId: session.userId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not record deposit";
    return jsonError(message, 400);
  }
}
