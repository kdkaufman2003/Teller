import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hfacWebhookAuthMode } from "@/lib/integrations/hfac-auth";
import {
  auditHfacWebhookAccepted,
  auditHfacWebhookRejected,
  HfacOrgRejectedError,
  resolveHfacWebhookOrganization,
} from "@/lib/integrations/hfac-org";
import { createServiceClient, hasServiceRole } from "@/lib/supabase/admin";

type HfacWebhookHandler<TBody extends Record<string, unknown>> = (
  supabase: SupabaseClient,
  organizationId: string,
  body: TBody,
) => Promise<unknown>;

export async function handleHfacWebhook<TBody extends Record<string, unknown>>(
  request: Request,
  route: string,
  body: TBody,
  handler: HfacWebhookHandler<TBody>,
) {
  const rawBody = JSON.stringify(body);

  if (!hfacWebhookAuthMode(request, rawBody)) {
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

  try {
    const { organizationId } = await resolveHfacWebhookOrganization(supabase, body);
    const result = await handler(supabase, organizationId, body);
    await auditHfacWebhookAccepted(supabase, organizationId, route);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof HfacOrgRejectedError) {
      await auditHfacWebhookRejected(supabase, {
        organizationId: claimedOrgId,
        reason: error.reason,
        route,
      });
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
