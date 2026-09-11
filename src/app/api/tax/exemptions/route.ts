import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { loadOrganizationTaxExemptions } from "@/lib/accounting/tax/exemptions/load";
import { createTaxExemption, serializeExemptionForClient } from "@/lib/accounting/tax/exemptions/service";
import type { CreateTaxExemptionInput } from "@/lib/accounting/tax/exemptions/types";
import { TAX_EXEMPTION_CERTIFICATE_TYPES } from "@/lib/accounting/tax/exemptions/types";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const url = new URL(request.url);
  const partyId = url.searchParams.get("partyId")?.trim() || undefined;
  const status = url.searchParams.get("status")?.trim() || undefined;

  const exemptions = await loadOrganizationTaxExemptions(supabase, organizationId, {
    partyId,
    status,
  });

  return NextResponse.json({
    exemptions: exemptions.map((row) => serializeExemptionForClient(row, "accountant")),
  });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as CreateTaxExemptionInput;
  if (!body.partyId?.trim()) return jsonError("Customer is required");
  if (!body.effectiveFrom?.trim()) return jsonError("Effective date is required");
  if (!Array.isArray(body.jurisdictionScope) || body.jurisdictionScope.length === 0) {
    return jsonError("At least one jurisdiction is required");
  }
  if (
    body.certificateType &&
    !TAX_EXEMPTION_CERTIFICATE_TYPES.includes(
      body.certificateType as (typeof TAX_EXEMPTION_CERTIFICATE_TYPES)[number],
    )
  ) {
    return jsonError("Invalid certificate type");
  }

  const created = await createTaxExemption(
    supabase,
    organizationId,
    {
      ...body,
      categoryScope: body.categoryScope?.length ? body.categoryScope : ["*"],
    },
    session.userId,
  );

  return NextResponse.json({ exemption: serializeExemptionForClient(created, "accountant") }, { status: 201 });
}
