import { NextResponse } from "next/server";
import { updateLegalEntity } from "@/lib/accounting/legal-entity";
import { requireWriteBooks } from "@/lib/api";
import type { LegalEntityType } from "@/lib/accounting/legal-entity/types";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id } = await context.params;
  const body = (await request.json()) as {
    name?: string;
    legalName?: string;
    entityType?: LegalEntityType;
    countryCode?: string;
    stateCode?: string;
    baseCurrency?: string;
  };

  const entity = await updateLegalEntity(ctx.supabase, {
    organizationId: ctx.organizationId,
    legalEntityId: id,
    name: body.name,
    legalName: body.legalName,
    entityType: body.entityType,
    countryCode: body.countryCode,
    stateCode: body.stateCode,
    baseCurrency: body.baseCurrency,
    actorId: ctx.session.userId,
  });

  return NextResponse.json({ entity });
}
