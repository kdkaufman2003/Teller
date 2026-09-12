import { NextResponse } from "next/server";
import { getIntercompanyPairBalance } from "@/lib/accounting/intercompany";
import { jsonError, requireAccountingBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const url = new URL(request.url);
  const entityAId = url.searchParams.get("entityAId")?.trim();
  const entityBId = url.searchParams.get("entityBId")?.trim();
  const asOf = url.searchParams.get("asOf")?.slice(0, 10);

  if (!entityAId || !entityBId) {
    return jsonError("entityAId and entityBId are required", 400);
  }

  try {
    const balance = await getIntercompanyPairBalance(supabase, {
      organizationId,
      entityAId,
      entityBId,
      asOf: asOf ?? undefined,
    });
    return NextResponse.json(balance);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not compute reconciliation", 400);
  }
}
