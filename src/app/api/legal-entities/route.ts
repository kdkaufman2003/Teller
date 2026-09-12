import { NextResponse } from "next/server";
import {
  createLegalEntity,
  listAccessibleLegalEntities,
  listLegalEntities,
} from "@/lib/accounting/legal-entity";
import { jsonError, requireEntityBooks, requireWriteBooks } from "@/lib/api";
import type { LegalEntityType } from "@/lib/accounting/legal-entity/types";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const includeInactive = url.searchParams.get("includeInactive") === "true";
  const ctx = await requireEntityBooks({
    requestedLegalEntityId: url.searchParams.get("legalEntityId"),
  });
  if ("error" in ctx && ctx.error) return ctx.error;

  const adminView = url.searchParams.get("admin") === "true";
  const entities = adminView
    ? await listLegalEntities(ctx.supabase, ctx.organizationId, { includeInactive })
    : await listAccessibleLegalEntities(ctx.supabase, ctx.organizationId, ctx.auth);

  return NextResponse.json({
    entities,
    activeLegalEntityId: ctx.legalEntityId,
    showEntitySwitcher: ctx.activeContext.showEntitySwitcher,
  });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const body = (await request.json()) as {
    name?: string;
    legalName?: string;
    entityCode?: string;
    entityType?: LegalEntityType;
    countryCode?: string;
    stateCode?: string;
    baseCurrency?: string;
    isDefault?: boolean;
  };

  if (!body.name?.trim() || !body.entityCode?.trim()) {
    return jsonError("Name and entity code are required");
  }

  const entity = await createLegalEntity(ctx.supabase, {
    organizationId: ctx.organizationId,
    name: body.name,
    legalName: body.legalName,
    entityCode: body.entityCode,
    entityType: body.entityType,
    countryCode: body.countryCode,
    stateCode: body.stateCode,
    baseCurrency: body.baseCurrency,
    isDefault: body.isDefault,
    actorId: ctx.session.userId,
  });

  return NextResponse.json({ entity }, { status: 201 });
}
