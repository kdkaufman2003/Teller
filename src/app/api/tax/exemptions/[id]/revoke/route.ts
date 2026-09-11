import { NextResponse } from "next/server";
import { jsonError, requireWriteBooks } from "@/lib/api";
import {
  getTaxExemptionById,
  revokeTaxExemption,
  serializeExemptionForClient,
} from "@/lib/accounting/tax/exemptions/service";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await context.params;

  const existing = await getTaxExemptionById(supabase, organizationId, id);
  if (!existing) return jsonError("Exemption not found", 404);

  const body = (await request.json()) as { revokedEffectiveFrom?: string };
  const revokedEffectiveFrom = body.revokedEffectiveFrom?.trim() || new Date().toISOString().slice(0, 10);

  const revoked = await revokeTaxExemption(
    supabase,
    organizationId,
    id,
    revokedEffectiveFrom,
    session.userId,
  );
  return NextResponse.json({ exemption: serializeExemptionForClient(revoked, "accountant") });
}
