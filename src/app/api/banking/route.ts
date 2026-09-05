import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { bankingConfigured } from "@/lib/banking/provider";
import { hasServiceRole } from "@/lib/supabase/admin";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const [{ data: connections }, { data: accounts }, { data: integration }] = await Promise.all([
    supabase
      .from("teller_bank_connections")
      .select("id, provider, institution_name, status, last_synced_at, last_sync_summary, error_message")
      .eq("organization_id", organizationId)
      .order("updated_at", { ascending: false }),
    supabase
      .from("teller_bank_accounts")
      .select("id, connection_id, name, mask, account_type, account_subtype, current_balance, teller_account_id")
      .eq("organization_id", organizationId)
      .order("name"),
    supabase
      .from("teller_integrations")
      .select("enabled, last_synced_at, last_sync_summary")
      .eq("organization_id", organizationId)
      .eq("provider", "plaid")
      .maybeSingle(),
  ]);

  const { count: unmatchedCount } = await supabase
    .from("teller_bank_transactions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("match_status", ["unmatched", "suggested"]);

  return NextResponse.json({
    configured: bankingConfigured(),
    serviceRoleConfigured: hasServiceRole(),
    connections: connections ?? [],
    accounts: accounts ?? [],
    integration: integration ?? null,
    unmatchedCount: unmatchedCount ?? 0,
  });
}
