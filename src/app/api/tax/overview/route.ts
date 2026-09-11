import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { parseCpaMode } from "@/lib/accounting/cpa";
import { getTaxOwnerSummary } from "@/lib/accounting/tax/owner";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const url = new URL(request.url);
  const asOfDate = url.searchParams.get("asOf") ?? undefined;
  const cpaMode = parseCpaMode(session?.settings?.answers?.cpaMode);
  const role = session?.profile?.role;
  const presentationMode =
    cpaMode || role === "bookkeeper" || role === "admin" ? "accountant" : "owner";

  try {
    const summary = await getTaxOwnerSummary(supabase, {
      organizationId,
      asOfDate,
      presentationMode,
    });
    return NextResponse.json(summary);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load tax overview", 500);
  }
}
