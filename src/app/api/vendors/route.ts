import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { recordAuditEvent } from "@/lib/accounting/audit";

const VENDOR_KINDS = ["vendor", "both"] as const;

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data, error } = await supabase
    .from("teller_parties")
    .select(
      "id, name, legal_name, email, phone, kind, party_status, vendor_category, payment_terms, default_due_days, eligible_1099, created_at",
    )
    .eq("organization_id", organizationId)
    .in("kind", [...VENDOR_KINDS])
    .order("name");

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ vendors: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as Record<string, unknown>;
  const name = String(body.name ?? "").trim();
  if (!name) return jsonError("Vendor name is required");

  const { data, error } = await supabase
    .from("teller_parties")
    .insert({
      organization_id: organizationId,
      kind: "vendor",
      name,
      legal_name: String(body.legalName ?? ""),
      email: String(body.email ?? ""),
      phone: String(body.phone ?? ""),
      notes: String(body.notes ?? ""),
      party_status: body.status === "inactive" ? "inactive" : "active",
      vendor_category: String(body.vendorCategory ?? ""),
      website: String(body.website ?? ""),
      payment_terms: String(body.paymentTerms ?? ""),
      default_due_days: body.defaultDueDays == null ? null : Number(body.defaultDueDays),
      preferred_payment_method: String(body.preferredPaymentMethod ?? ""),
      eligible_1099: Boolean(body.eligible1099),
      form_1099_category: String(body.form1099Category ?? ""),
      w9_received: Boolean(body.w9Received),
    })
    .select("id")
    .single();

  if (error || !data) return jsonError(error?.message || "Could not create vendor", 500);

  await recordAuditEvent(supabase, {
    organizationId,
    actorId: session.userId,
    action: "vendor.created",
    resourceKind: "vendor",
    resourceId: data.id as string,
    metadata: { name },
  });

  return NextResponse.json({ id: data.id });
}
