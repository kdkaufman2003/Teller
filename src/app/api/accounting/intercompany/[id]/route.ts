import { NextResponse } from "next/server";
import { jsonError, requireAccountingBooks } from "@/lib/api";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const { id } = await context.params;

  const { data, error } = await supabase
    .from("teller_intercompany_transactions")
    .select(
      "id, organization_id, source_legal_entity_id, counterparty_legal_entity_id, transaction_type, transaction_date, description, reference, amount, currency, status, source_journal_id, counterparty_journal_id, reversal_transaction_id, reverses_transaction_id, idempotency_key, created_at, reversed_at",
    )
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();

  if (error) return jsonError(error.message, 400);
  if (!data) return jsonError("Intercompany transaction not found", 404);

  const entityIds = [data.source_legal_entity_id, data.counterparty_legal_entity_id];
  const { data: entities } = await supabase
    .from("teller_legal_entities")
    .select("id, name, entity_code")
    .eq("organization_id", organizationId)
    .in("id", entityIds);

  return NextResponse.json({
    transaction: data,
    entities: entities ?? [],
  });
}
