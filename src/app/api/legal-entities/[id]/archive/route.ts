import { NextResponse } from "next/server";
import { archiveLegalEntity } from "@/lib/accounting/legal-entity";
import { requireWriteBooks } from "@/lib/api";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id } = await context.params;
  const entity = await archiveLegalEntity(ctx.supabase, {
    organizationId: ctx.organizationId,
    legalEntityId: id,
    actorId: ctx.session.userId,
  });

  return NextResponse.json({ entity });
}
