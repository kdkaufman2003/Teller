import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import {
  authoritativeDocumentRemaining,
  enrichDocumentsWithAuthoritativePaid,
} from "@/lib/accounting/balances";
import { sumCreditsAppliedFromDocument } from "@/lib/accounting/document-allocations";
import { asNumber } from "@/lib/format";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await context.params;
  const { supabase, organizationId } = ctx;

  const { data: vendor, error } = await supabase
    .from("teller_parties")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();

  if (error) return jsonError(error.message, 500);
  if (!vendor) return jsonError("Vendor not found", 404);

  const [{ data: bills }, { data: credits }, { data: payments }] = await Promise.all([
    supabase
      .from("teller_documents")
      .select("id, number, status, total, due_date, issue_date, reference_number")
      .eq("organization_id", organizationId)
      .eq("party_id", id)
      .eq("kind", "bill")
      .order("issue_date", { ascending: false })
      .limit(20),
    supabase
      .from("teller_documents")
      .select("id, number, status, total")
      .eq("organization_id", organizationId)
      .eq("party_id", id)
      .eq("kind", "vendor_credit")
      .order("issue_date", { ascending: false })
      .limit(10),
    supabase
      .from("teller_payments")
      .select("id, amount, payment_date, reference_number, status, payment_type")
      .eq("organization_id", organizationId)
      .eq("party_id", id)
      .eq("payment_type", "bill_payment")
      .order("payment_date", { ascending: false })
      .limit(10),
  ]);

  const enrichedBills = await enrichDocumentsWithAuthoritativePaid(
    supabase,
    organizationId,
    bills ?? [],
  );
  const openBills = await Promise.all(
    enrichedBills
      .filter((row) => row.status === "open" || row.status === "partially_paid")
      .map(async (row) => ({
        ...row,
        remaining: await authoritativeDocumentRemaining(
          supabase,
          organizationId,
          row.id as string,
          asNumber(row.total),
        ),
      })),
  );

  let unappliedCredits = 0;
  for (const credit of credits ?? []) {
    const applied = await sumCreditsAppliedFromDocument(supabase, organizationId, credit.id as string);
    const remaining = asNumber(credit.total) - applied;
    if (remaining > 0.009) unappliedCredits += remaining;
  }

  return NextResponse.json({
    vendor,
    openBills,
    vendorCredits: credits ?? [],
    recentPayments: payments ?? [],
    unappliedCredits,
    openApBalance: openBills.reduce((sum, row) => sum + row.remaining, 0),
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await context.params;
  const body = (await request.json()) as Record<string, unknown>;

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name != null) patch.name = String(body.name);
  if (body.email != null) patch.email = String(body.email);
  if (body.phone != null) patch.phone = String(body.phone);
  if (body.notes != null) patch.notes = String(body.notes);
  if (body.status != null) patch.party_status = body.status === "inactive" ? "inactive" : "active";
  if (body.paymentTerms != null) patch.payment_terms = String(body.paymentTerms);
  if (body.vendorCategory != null) patch.vendor_category = String(body.vendorCategory);

  const { error } = await ctx.supabase
    .from("teller_parties")
    .update(patch)
    .eq("organization_id", ctx.organizationId)
    .eq("id", id);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ ok: true });
}
