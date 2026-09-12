import type { SupabaseClient } from "@supabase/supabase-js";

async function resolveDefaultLegalEntityId(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("teller_default_legal_entity_id", {
    p_org_id: organizationId,
  });
  if (error || !data) {
    throw new Error(error?.message || "Default legal entity missing");
  }
  return data as string;
}

async function resolveLegalEntityIdsForReopen(
  supabase: SupabaseClient,
  organizationId: string,
  legalEntityId?: string | null,
): Promise<string[]> {
  if (legalEntityId?.trim()) return [legalEntityId.trim()];

  const { data, error } = await supabase
    .from("teller_legal_entities")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  if (data?.length) return data.map((row) => row.id as string);

  return [await resolveDefaultLegalEntityId(supabase, organizationId)];
}

/** Controlled demo only — append one reopen event per entity with open books (O(1) reset). */
export async function forceOpenDemoBooks(
  supabase: SupabaseClient,
  organizationId: string,
  reason = "Controlled demo force open",
) {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("forceOpenDemoBooks requires TELLER_CONTROLLED_PROD_TEST=1");
  }

  const entityIds = await resolveLegalEntityIdsForReopen(supabase, organizationId);
  const closedAt = new Date().toISOString();

  for (const entityId of entityIds) {
    const { data, error } = await supabase.rpc("teller_books_closed_through", {
      p_org: organizationId,
      p_legal_entity_id: entityId,
    });
    if (error) throw new Error(error.message);
    const closedThrough = (data as string | null)?.slice(0, 10) ?? null;
    if (!closedThrough) continue;

    const { error: insertError } = await supabase.from("teller_period_closes").insert({
      organization_id: organizationId,
      legal_entity_id: entityId,
      period_end: closedThrough,
      event_type: "reopen",
      effective_closed_through: null,
      reopen_reason: reason,
      closed_at: closedAt,
      notes: reason,
    });
    if (insertError) throw new Error(insertError.message);
  }

  for (const entityId of entityIds) {
    await supabase.from("teller_accounting_state_versions").upsert({
      organization_id: organizationId,
      legal_entity_id: entityId,
      accounting_version: 0,
      close_state_version: 0,
    });
  }
}

export async function resetDemoBooksOpen(
  supabase: SupabaseClient,
  organizationId: string,
  reason = "Controlled demo reset",
) {
  if (process.env.TELLER_CONTROLLED_PROD_TEST === "1") {
    await forceOpenDemoBooks(supabase, organizationId, reason);
    return;
  }
  await reopenAllPeriodCloses(supabase, organizationId, reason);
}

export async function insertDemoPeriodClose(
  supabase: SupabaseClient,
  organizationId: string,
  periodEnd: string,
  notes: string,
) {
  const legalEntityId = await resolveDefaultLegalEntityId(supabase, organizationId);
  const end = periodEnd.slice(0, 10);
  const { error } = await supabase.from("teller_period_closes").insert({
    organization_id: organizationId,
    legal_entity_id: legalEntityId,
    period_end: end,
    notes,
    event_type: "close",
    effective_closed_through: end,
    closed_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

/** Reopen through the latest close until books are open (post-025 immutable close events). */
export async function reopenAllPeriodCloses(
  supabase: SupabaseClient,
  organizationId: string,
  reason = "Controlled demo reset",
  legalEntityId?: string | null,
) {
  const entityIds = await resolveLegalEntityIdsForReopen(
    supabase,
    organizationId,
    legalEntityId,
  );

  for (const entityId of entityIds) {
    for (let attempt = 0; attempt < 512; attempt += 1) {
      const { data, error } = await supabase.rpc("teller_books_closed_through", {
        p_org: organizationId,
        p_legal_entity_id: entityId,
      });
      if (error) throw new Error(error.message);
      const closedThrough = (data as string | null)?.slice(0, 10) ?? null;
      if (!closedThrough) break;

      const { error: reopenError } = await supabase.rpc("teller_reopen_accounting_period", {
        p_organization_id: organizationId,
        p_legal_entity_id: entityId,
        p_period_end: closedThrough,
        p_reason: reason,
        p_actor_id: null,
      });
      if (reopenError) throw new Error(reopenError.message);
    }

    const { data: stillClosed, error: verifyError } = await supabase.rpc(
      "teller_books_closed_through",
      {
        p_org: organizationId,
        p_legal_entity_id: entityId,
      },
    );
    if (verifyError) throw new Error(verifyError.message);
    if ((stillClosed as string | null)?.slice(0, 10)) {
      throw new Error("Could not reopen all period closes within attempt limit");
    }
  }
}
