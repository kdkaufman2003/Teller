import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data, error } = await supabase
    .from("teller_accounts")
    .select("*")
    .eq("organization_id", organizationId)
    .order("code");

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ accounts: data ?? [] });
}
