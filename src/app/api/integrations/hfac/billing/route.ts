import {
  importBillingEntriesFromHfac,
  recordHfacWebhookDelivery,
  reconcileRemovedBillingInvoices,
  type HfacBillingEntry,
} from "@/lib/integrations/hfac";
import { handleHfacWebhook } from "@/lib/integrations/hfac-webhook";

function normalizeEntries(body: {
  entry?: HfacBillingEntry;
  entries?: HfacBillingEntry[];
}): HfacBillingEntry[] {
  if (Array.isArray(body.entries) && body.entries.length) {
    return body.entries;
  }
  if (body.entry?.id && body.entry.companyId) {
    return [body.entry];
  }
  return [];
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    organizationId?: string;
    entry?: HfacBillingEntry;
    entries?: HfacBillingEntry[];
    reconcile?: { activeExternalIds?: string[] };
  };

  const entries = normalizeEntries(body);
  const activeExternalIds = body.reconcile?.activeExternalIds;
  const hasReconcile = Array.isArray(activeExternalIds);

  if (!entries.length && !hasReconcile) {
    return Response.json({ error: "entry, entries, or reconcile is required" }, { status: 400 });
  }

  return handleHfacWebhook(request, "billing", body, async (supabase, organizationId) => {
    let result = { created: 0, updated: 0, paid: 0, voided: 0, skipped: 0 };

    if (entries.length) {
      result = await importBillingEntriesFromHfac(supabase, organizationId, entries);
    }

    if (hasReconcile) {
      const reconciled = await reconcileRemovedBillingInvoices(
        supabase,
        organizationId,
        activeExternalIds ?? [],
      );
      result = { ...result, voided: result.voided + reconciled };
    }

    await recordHfacWebhookDelivery(supabase, organizationId, result, "billing");
    return result;
  });
}
