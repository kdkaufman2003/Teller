import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { loadCashOutlookReport } from "@/lib/planning/cash/load-cash-outlook";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const asOfDate = url.searchParams.get("asOfDate") ?? undefined;
  const persist = url.searchParams.get("persist") === "1";

  const { data: accounts, error: accountsError } = await ctx.supabase
    .from("teller_accounts")
    .select("id, code, name, type, subtype, archived")
    .eq("organization_id", ctx.organizationId);
  if (accountsError) return jsonError(accountsError.message, 400);

  try {
    const report = await loadCashOutlookReport(ctx.supabase, ctx.organizationId, {
      asOfDate,
      accounts: (accounts ?? []) as Array<{
        id: string;
        code: string;
        name: string;
        type: string;
        subtype: string;
        archived?: boolean;
      }>,
      persistRun: persist,
      actorId: ctx.session.userId,
    });
    return NextResponse.json({ report });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load cash outlook", 400);
  }
}
