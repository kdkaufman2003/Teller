import { NextResponse } from "next/server";
import { buildTrialBalance } from "@/lib/accounting/trial-balance";
import { jsonError, requireBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { searchParams } = new URL(request.url);
  const periodEnd = String(searchParams.get("periodEnd") ?? searchParams.get("asOf") ?? "").slice(0, 10);
  const periodStart = searchParams.get("periodStart")?.slice(0, 10) ?? null;
  if (!periodEnd) return jsonError("periodEnd or asOf is required", 400);

  const report = await buildTrialBalance(supabase, organizationId, { periodStart, periodEnd });
  return NextResponse.json(report);
}
