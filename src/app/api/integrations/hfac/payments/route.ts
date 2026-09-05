import {
  importPaymentFromHfac,
  recordHfacWebhookDelivery,
  type HfacPayment,
} from "@/lib/integrations/hfac";
import { handleHfacWebhook } from "@/lib/integrations/hfac-webhook";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    organizationId?: string;
    payment?: HfacPayment;
  };

  if (!body.payment) {
    return Response.json({ error: "payment is required" }, { status: 400 });
  }

  return handleHfacWebhook(request, "payments", body, async (supabase, organizationId) => {
    const result = await importPaymentFromHfac(supabase, organizationId, body.payment!);
    await recordHfacWebhookDelivery(supabase, organizationId, result, "payments");
    return result;
  });
}
