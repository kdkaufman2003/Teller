import { NextResponse } from "next/server";
import { setDefaultLegalEntity } from "@/lib/accounting/legal-entity";
import { requireAdminBooks } from "@/lib/api";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const ctx = await requireAdminBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id } = await context.params;
  const entity = await setDefaultLegalEntity(ctx.supabase, {
    organizationId: ctx.organizationId,
    legalEntityId: id,
    actorId: ctx.session.userId,
  });

  return NextResponse.json({ entity });
}
