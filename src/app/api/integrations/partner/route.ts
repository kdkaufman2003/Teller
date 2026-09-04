import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { attachPartner, detachPartner } from "@/lib/partners/attachment";
import { getHfacPlatformUrl, getHfacWebhookUrl, getHfacWebhookUrls, getPartner } from "@/lib/partners/registry";

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
    organizationId,
    hfac: hfacIntegration ?? null,
  });
}

export async function POST(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const body = (await request.json()) as {
    action?: "attach" | "detach";
    partnerId?: string;
  };

  try {
    if (body.action === "attach") {
      if (body.partnerId !== "hasslefreeac") {
        return jsonError("This integration is not available yet.");
      }
      await attachPartner(supabase, organizationId, "hasslefreeac");
      return NextResponse.json({ ok: true, mode: "attached", partnerId: "hasslefreeac" });
    }

    if (body.action === "detach") {
      await detachPartner(supabase, organizationId);
      return NextResponse.json({ ok: true, mode: "standalone", partnerId: null });
    }

    return jsonError("Unknown action");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Partner update failed";
    return jsonError(message, 500);
  }
}
