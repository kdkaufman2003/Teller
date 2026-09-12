import { NextResponse } from "next/server";
import { resolveLegalEntityId } from "@/lib/accounting/post";
import { jsonError, requireAccountingBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId } = ctx;
  const entityId =
    legalEntityId ?? (await resolveLegalEntityId(supabase, organizationId, null));

  const { data, error } = await supabase
    .from("teller_accounts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", entityId)
    .order("code");

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ accounts: data ?? [] });
}
