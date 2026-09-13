import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyHfacWebhookAuth } from "@/lib/integrations/hfac-auth";
import {
  auditHfacWebhookAccepted,
  auditHfacWebhookRejected,
  claimHfacWebhookEvent,
  HfacOrgRejectedError,
  markHfacWebhookFailed,
  markHfacWebhookProcessed,
  resolveHfacWebhookOrganization,
} from "@/lib/integrations/hfac-org";
import { createServiceClient, hasServiceRole } from "@/lib/supabase/admin";

export class HfacWebhookClientError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "HfacWebhookClientError";
    this.status = status;
  }
}

type HfacWebhookHandler = (
  supabase: SupabaseClient,
  organizationId: string,
  body: Record<string, unknown>,
) => Promise<unknown>;

function logHfacAuthRejected(reason: string, route: string) {
  console.warn("HFAC webhook auth rejected", { reason, route });
}

export async function handleHfacWebhookRequest(
  request: Request,
  route: string,
  handler: HfacWebhookHandler,
) {
  const rawBody = await request.text();

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const auth = verifyHfacWebhookAuth(request, rawBody);
  if (!auth.ok) {
    logHfacAuthRejected(auth.reason, route);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasServiceRole()) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is required for inbound HFAC webhooks" },
      { status: 500 },
    );
  }

  const supabase = createServiceClient();
  const claimedOrgId =
    typeof body.organizationId === "string" ? body.organizationId.trim() : null;

  if (auth.eventId) {
    try {
      const claim = await claimHfacWebhookEvent(supabase, {
        eventId: auth.eventId,
        route,
        authMode: auth.mode,
      });
      if (claim.kind === "duplicate_processed") {
        return NextResponse.json({ ok: true, duplicate: true, alreadyProcessed: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not claim webhook event";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  try {
    const { organizationId } = await resolveHfacWebhookOrganization(supabase, body);

    const result = await handler(supabase, organizationId, body);

    if (auth.eventId) {
      await markHfacWebhookProcessed(supabase, {
        eventId: auth.eventId,
        organizationId,
      });
    }

    await auditHfacWebhookAccepted(supabase, organizationId, route, auth.mode);
    return NextResponse.json({ ok: true, result, authMode: auth.mode });
  } catch (error) {
    if (auth.eventId) {
      try {
        await markHfacWebhookFailed(supabase, {
          eventId: auth.eventId,
          organizationId: claimedOrgId,
          errorMessage: error instanceof Error ? error.message : "Import failed",
        });
      } catch {
        // Best-effort — allow HFAC retry even if status update fails
      }
    }

    if (error instanceof HfacOrgRejectedError) {
      await auditHfacWebhookRejected(supabase, {
        organizationId: claimedOrgId,
        reason: error.reason,
        route,
        authReason: auth.ok ? auth.mode : undefined,
      });
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    if (error instanceof HfacWebhookClientError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** @deprecated use handleHfacWebhookRequest with raw request body */
export async function handleHfacWebhook<TBody extends Record<string, unknown>>(
  request: Request,
  route: string,
  body: TBody,
  handler: (
    supabase: SupabaseClient,
    organizationId: string,
    body: TBody,
  ) => Promise<unknown>,
) {
  const rawBody = JSON.stringify(body);
  const wrappedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: rawBody,
  });
  return handleHfacWebhookRequest(wrappedRequest, route, (supabase, organizationId) =>
    handler(supabase, organizationId, body),
  );
}
