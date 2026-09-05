import {
  importWonQuotesFromHfac,
  recordHfacWebhookDelivery,
  type HfacWonQuote,
} from "@/lib/integrations/hfac";
import { handleHfacWebhookRequest } from "@/lib/integrations/hfac-webhook";

export async function POST(request: Request) {
  return handleHfacWebhookRequest(request, "quotes", async (supabase, organizationId, body) => {
    const quote = body.quote as HfacWonQuote | undefined;
    if (!quote?.id) {
      throw new Error("quote.id is required");
    }
    const normalized: HfacWonQuote = {
      ...quote,
      source: quote.source || "deal",
    };
    const result = await importWonQuotesFromHfac(supabase, organizationId, [normalized], {
      createJobs: body.createJobs !== false,
    });
    await recordHfacWebhookDelivery(supabase, organizationId, result, "quotes");
    return result;
  });
}
