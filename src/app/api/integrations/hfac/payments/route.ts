import { NextResponse } from "next/server";
import {
  importPaymentFromHfac,
  recordHfacWebhookDelivery,
  type HfacPayment,
} from "@/lib/integrations/hfac";
import { hfacWebhookAuthorized } from "@/lib/integrations/hfac-auth";
import { createServiceClient, hasServiceRole } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  if (!hfacWebhookAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasServiceRole()) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is required for inbound payments" },
      { status: 500 },
    );
  }

  const body = (await request.json()) as {
    organizationId?: string;
    payment?: HfacPayment;
  };

  if (!body.organizationId || !body.payment) {
    return NextResponse.json(
      { error: "organizationId and payment are required" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    const result = await importPaymentFromHfac(
      supabase,
      body.organizationId,
      body.payment,
    );
    await recordHfacWebhookDelivery(supabase, body.organizationId, result, "payments");
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payment import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
