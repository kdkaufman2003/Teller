import { NextResponse } from "next/server";
import {
  grantEntityAccess,
  listEntityMembershipsForProfile,
  revokeEntityAccess,
} from "@/lib/accounting/legal-entity";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { jsonError, requireAdminBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireAdminBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const profileId = url.searchParams.get("profileId")?.trim();
  if (!profileId) return jsonError("profileId is required");

  const memberships = await listEntityMembershipsForProfile(
    ctx.supabase,
    ctx.organizationId,
    profileId,
  );

  return NextResponse.json({ memberships });
}

export async function POST(request: Request) {
  const ctx = await requireAdminBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const body = (await request.json()) as {
    profileId?: string;
    legalEntityId?: string;
  };

  if (!body.profileId?.trim() || !body.legalEntityId?.trim()) {
    return jsonError("profileId and legalEntityId are required");
  }

  const membership = await grantEntityAccess(ctx.supabase, {
    organizationId: ctx.organizationId,
    profileId: body.profileId.trim(),
    legalEntityId: body.legalEntityId.trim(),
  });

  await recordAuditEvent(ctx.supabase, {
    organizationId: ctx.organizationId,
    actorId: ctx.session.userId,
    action: "legal_entity.access_granted",
    resourceKind: "legal_entity_membership",
    resourceId: membership.id,
    metadata: {
      profileId: membership.profileId,
      legalEntityId: membership.legalEntityId,
    },
  });

  return NextResponse.json({ membership }, { status: 201 });
}

export async function DELETE(request: Request) {
  const ctx = await requireAdminBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const profileId = url.searchParams.get("profileId")?.trim();
  const legalEntityId = url.searchParams.get("legalEntityId")?.trim();

  if (!profileId || !legalEntityId) {
    return jsonError("profileId and legalEntityId are required");
  }

  await revokeEntityAccess(ctx.supabase, {
    organizationId: ctx.organizationId,
    profileId,
    legalEntityId,
  });

  await recordAuditEvent(ctx.supabase, {
    organizationId: ctx.organizationId,
    actorId: ctx.session.userId,
    action: "legal_entity.access_revoked",
    resourceKind: "legal_entity_membership",
    metadata: { profileId, legalEntityId },
  });

  return NextResponse.json({ ok: true });
}
