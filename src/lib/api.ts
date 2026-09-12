import { NextResponse } from "next/server";
import {
  resolveActiveLegalEntityContext,
  resolveAuthorizedLegalEntity,
  accountingContext,
} from "@/lib/accounting/legal-entity";
import { canWriteBooks } from "@/lib/auth/roles";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import type { ProfileRole } from "@/types";

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function requireBooks() {
  const session = await getSessionContext();
  if (!session) return { error: jsonError("Unauthorized", 401) as NextResponse };
  if (!session.organization) {
    return { error: jsonError("Complete setup first", 409) as NextResponse };
  }
  const supabase = await createClient();
  const organizationId = session.organization.id;

  let legalEntityId: string | undefined;
  let legalEntityName: string | undefined;
  if (session.profile) {
    try {
      const auth = entityAuthFromSession(session);
      const active = await resolveActiveLegalEntityContext(supabase, {
        organizationId,
        auth,
        persistedLegalEntityId: session.profile.active_legal_entity_id ?? null,
      });
      legalEntityId = active.legalEntityId;
      legalEntityName = active.legalEntity.name;
    } catch {
      legalEntityId = undefined;
    }
  }

  return {
    session,
    supabase,
    organizationId,
    legalEntityId,
    legalEntityName,
    accountingContext:
      legalEntityId != null ? accountingContext(organizationId, legalEntityId) : undefined,
  };
}

/** Entity-scoped accounting read guard (revalidates active/requested entity). */
export async function requireAccountingBooks(options?: {
  requestedLegalEntityId?: string | null;
}) {
  return requireEntityBooks(options);
}

/** Entity-scoped accounting write guard. */
export async function requireAccountingWriteBooks(options?: {
  requestedLegalEntityId?: string | null;
}) {
  const ctx = await requireEntityBooks(options);
  if ("error" in ctx && ctx.error) return ctx;
  if (!canWriteBooks(ctx.session.profile?.role)) {
    return { error: jsonError("You do not have permission to change books", 403) as NextResponse };
  }
  return ctx;
}

/** Entity-scoped accounting admin guard (period close, etc.). */
export async function requireAccountingAdminBooks(options?: {
  requestedLegalEntityId?: string | null;
}) {
  const ctx = await requireEntityBooks(options);
  if ("error" in ctx && ctx.error) return ctx;
  const role = ctx.session.profile?.role;
  if (role !== "owner" && role !== "admin") {
    return { error: jsonError("Only owners and admins can perform this action", 403) as NextResponse };
  }
  return ctx;
}

/** Requires owner or admin (period close, CPA settings). */
export async function requireAdminBooks() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx;
  const role = ctx.session.profile?.role;
  if (role !== "owner" && role !== "admin") {
    return { error: jsonError("Only owners and admins can perform this action", 403) as NextResponse };
  }
  return ctx;
}

/** Requires an authenticated org member who can change books (not viewer). */
export async function requireWriteBooks() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx;
  if (!canWriteBooks(ctx.session.profile?.role)) {
    return { error: jsonError("You do not have permission to change books", 403) as NextResponse };
  }
  return ctx;
}

function entityAuthFromSession(session: NonNullable<Awaited<ReturnType<typeof getSessionContext>>>) {
  const role = (session.profile?.role ?? "viewer") as ProfileRole;
  return { userId: session.userId, role };
}

/**
 * Canonical entity-aware books guard.
 * Revalidates persisted or requested entity IDs on every call.
 */
export async function requireEntityBooks(options?: {
  requestedLegalEntityId?: string | null;
  allowInactive?: boolean;
}) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx;

  const auth = entityAuthFromSession(ctx.session);
  const persistedLegalEntityId = ctx.session.profile?.active_legal_entity_id ?? null;

  try {
    const activeContext = await resolveActiveLegalEntityContext(ctx.supabase, {
      organizationId: ctx.organizationId,
      auth,
      persistedLegalEntityId,
      requestedLegalEntityId: options?.requestedLegalEntityId,
    });

    if (options?.requestedLegalEntityId?.trim()) {
      const entity = await resolveAuthorizedLegalEntity(ctx.supabase, {
        organizationId: ctx.organizationId,
        requestedLegalEntityId: options.requestedLegalEntityId,
        allowInactive: options.allowInactive,
        auth,
      });
      return {
        ...ctx,
        legalEntity: entity,
        legalEntityId: entity.id,
        accountingContext: accountingContext(ctx.organizationId, entity.id),
        activeContext,
        auth,
      };
    }

    return {
      ...ctx,
      legalEntity: activeContext.legalEntity,
      legalEntityId: activeContext.legalEntityId,
      accountingContext: activeContext,
      activeContext,
      auth,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Legal entity access denied";
    const status = /not found/i.test(message) ? 404 : 403;
    return { error: jsonError(message, status) as NextResponse };
  }
}
