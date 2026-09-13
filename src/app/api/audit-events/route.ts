import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { fetchPaginatedAuditEvents } from "@/lib/operations/audit-query";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { searchParams } = new URL(request.url);

  try {
    const result = await fetchPaginatedAuditEvents(supabase, {
      organizationId,
      searchParams,
      resourceKind: searchParams.get("resourceKind") ?? undefined,
      resourceId: searchParams.get("resourceId") ?? undefined,
      action: searchParams.get("action") ?? undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load audit events", 500);
  }
}
