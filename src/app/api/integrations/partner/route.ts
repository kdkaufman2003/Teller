import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { configExternalId, setHfacExternalMapping } from "@/lib/integrations/hfac-org";
import { attachPartner, defaultHfacCompanyId, detachPartner } from "@/lib/partners/attachment";
import { getHfacPlatformUrl, getHfacWebhookUrl, getHfacWebhookUrls, getPartner, getTellerPublicUrl } from "@/lib/partners/registry";
import { hasServiceRole } from "@/lib/supabase/admin";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { session, supabase, organizationId } = ctx;

  const partnerId = session.organization?.partner_id ?? null;
  const partner = getPartner(partnerId);

  const { data: integrations } = await supabase
    .from("teller_integrations")
    .select("provider, enabled, last_synced_at, last_sync_summary, config")
    .eq("organization_id", organizationId);

  const hfacIntegration = (integrations ?? []).find(
    (row) => row.provider === "hfac" || row.provider === "quoter",
  );

  return NextResponse.json({
    mode: partnerId ? "attached" : "standalone",
    partnerId,
    partner,
    platformUrl: getHfacPlatformUrl(),
    webhookUrl: getHfacWebhookUrl(),
    webhookUrls: getHfacWebhookUrls(),
    diagnostics: {
      webhookSecretConfigured: Boolean(
        process.env.TELLER_HFAC_WEBHOOK_SECRET?.trim() ||
          process.env.TELLER_QUOTER_WEBHOOK_SECRET?.trim(),
      ),
      serviceRoleConfigured: hasServiceRole(),
      publicUrlConfigured: Boolean(getTellerPublicUrl()),
    },
    organizationId,
    hfacCompanyId: configExternalId(hfacIntegration?.config) ?? null,
    defaultHfacCompanyId: defaultHfacCompanyId(),
    hfac: hfacIntegration ?? null,
  });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const body = (await request.json()) as {
    action?: "attach" | "detach" | "map-external";
    partnerId?: string;
    externalAccountId?: string;
  };

  try {
    if (body.action === "attach") {
      if (body.partnerId !== "hasslefreeac") {
        return jsonError("This integration is not available yet.");
      }
      await attachPartner(supabase, organizationId, "hasslefreeac");
      await setHfacExternalMapping(supabase, organizationId, defaultHfacCompanyId());
      return NextResponse.json({ ok: true, mode: "attached", partnerId: "hasslefreeac" });
    }

    if (body.action === "detach") {
      await detachPartner(supabase, organizationId);
      return NextResponse.json({ ok: true, mode: "standalone", partnerId: null });
    }

    if (body.action === "map-external") {
      const externalAccountId = body.externalAccountId?.trim() || defaultHfacCompanyId();
      if (!externalAccountId) {
        return jsonError("HFAC company/account ID is required");
      }
      await setHfacExternalMapping(supabase, organizationId, externalAccountId);
      return NextResponse.json({ ok: true, hfacCompanyId: externalAccountId });
    }

    return jsonError("Unknown action");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Partner update failed";
    return jsonError(message, 500);
  }
}
