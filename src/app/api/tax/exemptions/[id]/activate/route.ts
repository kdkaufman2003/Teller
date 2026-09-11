import { NextResponse } from "next/server";
import { jsonError, requireWriteBooks } from "@/lib/api";
import {
  activateTaxExemption,
  getTaxExemptionById,
  serializeExemptionForClient,
} from "@/lib/accounting/tax/exemptions/service";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await context.params;

  const existing = await getTaxExemptionById(supabase, organizationId, id);
  if (!existing) return jsonError("Exemption not found", 404);

  const activated = await activateTaxExemption(supabase, organizationId, id, session.userId);
  return NextResponse.json({ exemption: serializeExemptionForClient(activated, "accountant") });
}
