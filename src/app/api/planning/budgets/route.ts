import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { createBudgetWithBaseline } from "@/lib/planning/budgets/budget-crud";
import type { BudgetBaselineKind } from "@/lib/planning/budgets/types";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { data, error } = await ctx.supabase
    .from("teller_budgets")
    .select("*, teller_budget_versions(id, version_number, status, label, created_at)")
    .eq("organization_id", ctx.organizationId)
    .order("fiscal_year", { ascending: false });

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({ budgets: [], schemaReady: false });
    }
    return jsonError(error.message, 500);
  }

  return NextResponse.json({ budgets: data ?? [], schemaReady: true });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const body = (await request.json()) as {
    name?: string;
    fiscalYear?: number;
    baselineKind?: BudgetBaselineKind;
  };

  if (!body.name || body.fiscalYear == null) {
    return jsonError("name and fiscalYear are required", 400);
  }

  try {
    const result = await createBudgetWithBaseline(ctx.supabase, {
      organizationId: ctx.organizationId,
      name: body.name,
      fiscalYear: Number(body.fiscalYear),
      baselineKind: body.baselineKind ?? "blank",
      actorId: ctx.session.userId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not create budget", 400);
  }
}
