import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { getBudgetWithVersions } from "@/lib/planning/budgets/budget-crud";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id } = await context.params;

  try {
    const result = await getBudgetWithVersions(ctx.supabase, ctx.organizationId, id);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return jsonError(error.message, 404);
    }
    if (error instanceof Error && /does not exist|schema cache/i.test(error.message)) {
      return jsonError("Apply migration 032 to enable budgets", 503);
    }
    return jsonError(error instanceof Error ? error.message : "Could not load budget", 500);
  }
}
