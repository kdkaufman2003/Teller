import { NextResponse } from "next/server";
import { persistActiveLegalEntity } from "@/lib/accounting/legal-entity";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { jsonError, requireEntityBooks } from "@/lib/api";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ctx = await requireEntityBooks({
    requestedLegalEntityId: url.searchParams.get("legalEntityId"),
  });
  if ("error" in ctx && ctx.error) return ctx.error;

  return NextResponse.json({
    activeLegalEntity: ctx.legalEntity,
    accessibleEntities: ctx.activeContext.accessibleEntities,
    showEntitySwitcher: ctx.activeContext.showEntitySwitcher,
  });
}

export async function POST(request: Request) {
  const ctx = await requireEntityBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const body = (await request.json()) as { legalEntityId?: string };
  if (!body.legalEntityId?.trim()) {
    return jsonError("legalEntityId is required");
  }

  try {
    const activeContext = await persistActiveLegalEntity(ctx.supabase, {
      organizationId: ctx.organizationId,
      userId: ctx.session.userId,
      role: ctx.auth.role,
      legalEntityId: body.legalEntityId.trim(),
    });

    await recordAuditEvent(ctx.supabase, {
      organizationId: ctx.organizationId,
      actorId: ctx.session.userId,
      action: "legal_entity.active_changed",
      resourceKind: "legal_entity",
      resourceId: activeContext.legalEntityId,
    });

    return NextResponse.json({
      activeLegalEntity: activeContext.legalEntity,
      accessibleEntities: activeContext.accessibleEntities,
      showEntitySwitcher: activeContext.showEntitySwitcher,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not switch company";
    const status = /archived|inactive|access/i.test(message) ? 403 : 400;
    return jsonError(message, status);
  }
}
