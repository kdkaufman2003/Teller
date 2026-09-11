import {
  importSubscribersFromHfac,
  recordHfacWebhookDelivery,
  type HfacSubscriber,
} from "@/lib/integrations/hfac";
import { handleHfacWebhookRequest, HfacWebhookClientError } from "@/lib/integrations/hfac-webhook";

function normalizeSubscribers(body: Record<string, unknown>): HfacSubscriber[] {
  const subscribers = body.subscribers;
  if (Array.isArray(subscribers) && subscribers.length) {
    return subscribers as HfacSubscriber[];
  }
  const subscriber = body.subscriber as HfacSubscriber | undefined;
  if (subscriber?.id) return [subscriber];
  return [];
}

export async function POST(request: Request) {
  return handleHfacWebhookRequest(request, "subscribers", async (supabase, organizationId, body) => {
    const subscribers = normalizeSubscribers(body);
    if (!subscribers.length) {
      throw new HfacWebhookClientError("subscriber or subscribers is required");
    }
    const result = await importSubscribersFromHfac(supabase, organizationId, subscribers);
    await recordHfacWebhookDelivery(supabase, organizationId, result, "subscribers");
    return result;
  });
}
