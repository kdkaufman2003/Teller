import {
  importBillingEntriesFromHfac,
  recordHfacWebhookDelivery,
  reconcileRemovedBillingInvoices,
  type HfacBillingEntry,
} from "@/lib/integrations/hfac";
import { handleHfacWebhookRequest } from "@/lib/integrations/hfac-webhook";

function normalizeEntries(body: Record<string, unknown>): HfacBillingEntry[] {
  const entries = body.entries;
  if (Array.isArray(entries) && entries.length) {
    return entries as HfacBillingEntry[];
  }
  const entry = body.entry as HfacBillingEntry | undefined;
  if (entry?.id && entry.companyId) return [entry];
  return [];
}

export async function POST(request: Request) {
  return handleHfacWebhookRequest(request, "billing", async (supabase, organizationId, body) => {
    const entries = normalizeEntries(body);
    const reconcile = body.reconcile as { activeExternalIds?: string[] } | undefined;
    const activeExternalIds = reconcile?.activeExternalIds;
    const hasReconcile = Array.isArray(activeExternalIds);

    if (!entries.length && !hasReconcile) {
      throw new Error("entry, entries, or reconcile is required");
    }

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
