import type { SupabaseClient } from "@supabase/supabase-js";
import { parseListPagination } from "@/lib/performance/pagination";

export type AuditEventRow = {
  id: string;
  organization_id: string;
  actor_id: string | null;
  action: string;
  resource_kind: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export async function fetchPaginatedAuditEvents(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    searchParams: URLSearchParams;
    resourceKind?: string;
    resourceId?: string;
    action?: string;
  },
) {
  const { page, pageSize, offset } = parseListPagination(input.searchParams);

  let query = supabase
    .from("teller_audit_events")
    .select(
      "id, organization_id, actor_id, action, resource_kind, resource_id, metadata, created_at",
      { count: "exact" },
    )
    .eq("organization_id", input.organizationId)
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (input.resourceKind) query = query.eq("resource_kind", input.resourceKind);
  if (input.resourceId) query = query.eq("resource_id", input.resourceId);
  if (input.action) query = query.eq("action", input.action);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  return {
    events: (data ?? []) as AuditEventRow[],
    pagination: {
      page,
      pageSize,
      total: count ?? 0,
      hasMore: (count ?? 0) > offset + pageSize,
    },
  };
}
