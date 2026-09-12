import { NextResponse } from "next/server";
import { listIntercompanyOpenItems } from "@/lib/accounting/intercompany/settlement";
import { jsonError, requireAccountingBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const url = new URL(request.url);
  const entityAId = url.searchParams.get("entityAId");
  const entityBId = url.searchParams.get("entityBId");
  const asOf = url.searchParams.get("asOf") ?? undefined;

  if (!entityAId || !entityBId) {
    return jsonError("entityAId and entityBId are required", 400);
  }

  try {
    const items = await listIntercompanyOpenItems(supabase, {
      organizationId,
      entityAId,
      entityBId,
      asOf,
    });
    return NextResponse.json({ openItems: items });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not list open items", 400);
  }
}
