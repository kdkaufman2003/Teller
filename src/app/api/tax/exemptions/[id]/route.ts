import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import {
  getTaxExemptionById,
  serializeExemptionForClient,
  updateTaxExemption,
} from "@/lib/accounting/tax/exemptions/service";
import type { UpdateTaxExemptionInput } from "@/lib/accounting/tax/exemptions/types";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const { id } = await context.params;

  const exemption = await getTaxExemptionById(supabase, organizationId, id);
  if (!exemption) return jsonError("Exemption not found", 404);

  return NextResponse.json({ exemption: serializeExemptionForClient(exemption, "accountant") });
}

export async function PATCH(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await context.params;

  const existing = await getTaxExemptionById(supabase, organizationId, id);
  if (!existing) return jsonError("Exemption not found", 404);

  const body = (await request.json()) as UpdateTaxExemptionInput;
  const updated = await updateTaxExemption(supabase, organizationId, id, body, session.userId);
  return NextResponse.json({ exemption: serializeExemptionForClient(updated, "accountant") });
}
