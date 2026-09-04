import { NextResponse } from "next/server";
import {
  importSubscribersFromHfac,
  recordHfacWebhookDelivery,
  type HfacSubscriber,
} from "@/lib/integrations/hfac";
import { hfacWebhookAuthorized } from "@/lib/integrations/hfac-auth";
import { createServiceClient, hasServiceRole } from "@/lib/supabase/admin";

function normalizeSubscribers(body: {
  subscriber?: HfacSubscriber;
  subscribers?: HfacSubscriber[];
}): HfacSubscriber[] {
  if (Array.isArray(body.subscribers) && body.subscribers.length) {
    return body.subscribers;
  }
  if (body.subscriber?.id) {
    return [body.subscriber];
  }
  return [];
}

export async function POST(request: Request) {
  if (!hfacWebhookAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasServiceRole()) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is required for inbound subscribers" },
      { status: 500 },
    );
  }

  const body = (await request.json()) as {
    organizationId?: string;
    subscriber?: HfacSubscriber;
    subscribers?: HfacSubscriber[];
  };

  if (!body.organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }

  const subscribers = normalizeSubscribers(body);
  if (!subscribers.length) {
    return NextResponse.json(
      { error: "subscriber or subscribers is required" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    const result = await importSubscribersFromHfac(
      supabase,
      body.organizationId,
      subscribers,
    );
    await recordHfacWebhookDelivery(supabase, body.organizationId, result, "subscribers");
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
