import type { SupabaseClient } from "@supabase/supabase-js";
import { assertSameOrganization } from "../tenant-isolation";
import { buildLineDeterminationSnapshot } from "./snapshot";
import type { TaxCalculationInput, TaxCalculationResult } from "./types";

/** Draft snapshot persistence — never marks posted/immutable in 15B preview flows. */
export async function persistDraftTaxDeterminations(
  supabase: SupabaseClient,
  organizationId: string,
  input: TaxCalculationInput,
  result: TaxCalculationResult,
  source?: { documentId?: string | null },
): Promise<{ snapshotIds: string[] }> {
  const snapshotIds: string[] = [];

  for (const line of result.lineResults) {
    const payload = buildLineDeterminationSnapshot(organizationId, input.transactionDate, line, result, {
      documentId: source?.documentId,
      lineId: line.lineId,
    });
    assertSameOrganization(organizationId, payload.organizationId, "Tax snapshot");

    const { data, error } = await supabase
      .from("teller_tax_determination_snapshots")
      .insert({
        organization_id: organizationId,
        document_id: payload.documentId,
        line_id: payload.lineId,
        transaction_date: payload.transactionDate,
        tax_category_key: payload.taxCategoryKey,
        jurisdiction_key: payload.jurisdictionKey,
        determination_status: payload.determinationStatus,
        taxable_basis: payload.taxableBasis,
        tax_amount: payload.taxAmount,
        rate_percent: payload.ratePercent,
        rule_key: payload.ruleKey,
        exemption_id: payload.exemptionId ?? null,
        components: payload.components,
        precedence_trace: payload.precedenceTrace,
        metadata: payload.metadata,
      })
      .select("id")
      .single();

    if (error) throw new Error(error.message);
    snapshotIds.push(data.id);
  }

  return { snapshotIds };
}
