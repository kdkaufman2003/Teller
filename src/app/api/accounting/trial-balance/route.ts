import { NextResponse } from "next/server";
import { buildTrialBalance } from "@/lib/accounting/trial-balance";
import { resolveLegalEntityId } from "@/lib/accounting/post";
import { jsonError, requireAccountingBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId } = ctx;

  const { searchParams } = new URL(request.url);
  const periodEnd = String(searchParams.get("periodEnd") ?? searchParams.get("asOf") ?? "").slice(0, 10);
  const periodStart = searchParams.get("periodStart")?.slice(0, 10) ?? null;
  if (!periodEnd) return jsonError("periodEnd or asOf is required", 400);

  const entityId =
    legalEntityId ?? (await resolveLegalEntityId(supabase, organizationId, null));
  const report = await buildTrialBalance(supabase, organizationId, {
    legalEntityId: entityId,
    periodStart,
    periodEnd,
  });
  return NextResponse.json(report);
}
