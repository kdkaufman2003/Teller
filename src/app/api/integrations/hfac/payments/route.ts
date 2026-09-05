import {
  importPaymentFromHfac,
  recordHfacWebhookDelivery,
  type HfacPayment,
} from "@/lib/integrations/hfac";
import { handleHfacWebhookRequest } from "@/lib/integrations/hfac-webhook";

export async function POST(request: Request) {
  return handleHfacWebhookRequest(request, "payments", async (supabase, organizationId, body) => {
    const payment = body.payment as HfacPayment | undefined;
    if (!payment) {
      throw new Error("payment is required");
    }
    const result = await importPaymentFromHfac(supabase, organizationId, payment);
    await recordHfacWebhookDelivery(supabase, organizationId, result, "payments");
    return result;
  });
}
