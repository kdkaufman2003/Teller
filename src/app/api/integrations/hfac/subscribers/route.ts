import {
  importSubscribersFromHfac,
  recordHfacWebhookDelivery,
  type HfacSubscriber,
} from "@/lib/integrations/hfac";
import { handleHfacWebhook } from "@/lib/integrations/hfac-webhook";

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
  const body = (await request.json()) as {
    organizationId?: string;
    subscriber?: HfacSubscriber;
    subscribers?: HfacSubscriber[];
  };

  const subscribers = normalizeSubscribers(body);
  if (!subscribers.length) {
    return Response.json(
      { error: "subscriber or subscribers is required" },
      { status: 400 },
    );
  }

  return handleHfacWebhook(request, "subscribers", body, async (supabase, organizationId) => {
    const result = await importSubscribersFromHfac(supabase, organizationId, subscribers);
    await recordHfacWebhookDelivery(supabase, organizationId, result, "subscribers");
    return result;
  });
}
