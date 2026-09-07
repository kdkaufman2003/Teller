import { NextResponse } from "next/server";
import { jsonError, requireWriteBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data, error } = await supabase
    .from("teller_accrual_settlements")
    .select(
      "id, bill_id, status, actual_amount, estimated_amount, variance_amount, settled_at, settlement_journal_entry_id, teller_documents(number, issue_date, party_id)",
    )
    .eq("organization_id", organizationId)
    .order("settled_at", { ascending: false })
    .limit(100);

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({ settlements: [], migrationRequired: true });
    }
    return jsonError(error.message, 500);
  }

  return NextResponse.json({ settlements: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  return jsonError("Post settlements via bill posting with accrual allocations", 405);
}
