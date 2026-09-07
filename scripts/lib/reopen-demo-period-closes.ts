import type { SupabaseClient } from "@supabase/supabase-js";

/** Reopen through the latest close until books are open (post-025 immutable close events). */
export async function reopenAllPeriodCloses(
  supabase: SupabaseClient,
  organizationId: string,
  reason = "Controlled demo reset",
) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const { data, error } = await supabase.rpc("teller_books_closed_through", {
      p_org: organizationId,
    });
    if (error) throw new Error(error.message);
    const closedThrough = (data as string | null)?.slice(0, 10) ?? null;
    if (!closedThrough) return;

    const { error: reopenError } = await supabase.rpc("teller_reopen_accounting_period", {
      p_organization_id: organizationId,
      p_period_end: closedThrough,
      p_reason: reason,
      p_actor_id: null,
    });
    if (reopenError) throw new Error(reopenError.message);
  }

  throw new Error("Could not reopen all period closes within attempt limit");
}
