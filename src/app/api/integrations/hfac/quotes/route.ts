import {
  importWonQuotesFromHfac,
  recordHfacWebhookDelivery,
  type HfacWonQuote,
} from "@/lib/integrations/hfac";
import { handleHfacWebhook } from "@/lib/integrations/hfac-webhook";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    organizationId?: string;
    createJobs?: boolean;
    quote?: HfacWonQuote;
  };

  if (!body.quote?.id) {
    return Response.json({ error: "quote.id is required" }, { status: 400 });
  }

  return handleHfacWebhook(request, "quotes", body, async (supabase, organizationId) => {
    const quote: HfacWonQuote = {
      ...body.quote!,
      source: body.quote!.source || "deal",
    };
    const result = await importWonQuotesFromHfac(supabase, organizationId, [quote], {
      createJobs: body.createJobs !== false,
    });
    await recordHfacWebhookDelivery(supabase, organizationId, result, "quotes");
    return result;
  });
}
