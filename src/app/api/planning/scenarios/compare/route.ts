import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { compareScenarios } from "@/lib/planning/scenarios/load-scenario-report";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const scenarioIds = url.searchParams.getAll("scenarioId");
  const baseScenarioId = url.searchParams.get("baseScenarioId");
  const asOfDate = url.searchParams.get("asOfDate") ?? undefined;

  if (!scenarioIds.length) {
    return jsonError("At least one scenarioId is required", 400);
  }
  if (scenarioIds.length > 4) {
    return jsonError("Compare at most 4 scenarios at once", 400);
  }

  const { data: accounts, error: accountsError } = await ctx.supabase
    .from("teller_accounts")
    .select("id, code, name, type, subtype, archived")
    .eq("organization_id", ctx.organizationId);
  if (accountsError) return jsonError(accountsError.message, 400);

  try {
    const comparison = await compareScenarios(ctx.supabase, ctx.organizationId, {
      scenarioIds,
      baseScenarioId,
      asOfDate,
      accounts: (accounts ?? []) as Array<{
        id: string;
        code: string;
        name: string;
        type: string;
        subtype: string;
        archived?: boolean;
      }>,
    });
    return NextResponse.json({ comparison });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not compare scenarios", 400);
  }
}
