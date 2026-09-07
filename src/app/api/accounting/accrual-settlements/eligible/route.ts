import { NextResponse } from "next/server";
import { listEligibleAccrualOccurrences } from "@/lib/accounting/accrual-settlement/settlement-service";
import { jsonError, requireBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const url = new URL(request.url);
  const billPartyId = url.searchParams.get("partyId");
  const asOfDate = url.searchParams.get("asOfDate") ?? undefined;

  try {
    const eligible = await listEligibleAccrualOccurrences(supabase, {
      organizationId,
      billPartyId: billPartyId || undefined,
      asOfDate,
    });
    return NextResponse.json({ eligible });
  } catch (error) {
    if (/does not exist|schema cache/i.test(error instanceof Error ? error.message : "")) {
      return NextResponse.json({ eligible: [], migrationRequired: true });
    }
    return jsonError(error instanceof Error ? error.message : "Could not load eligible accruals", 500);
  }
}
