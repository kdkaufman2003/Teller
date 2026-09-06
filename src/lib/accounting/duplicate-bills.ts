import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";

export type DuplicateBillWarning = {
  level: "high" | "medium";
  message: string;
  documentIds: string[];
};

export async function detectDuplicateBillWarnings(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    partyId: string;
    referenceNumber?: string;
    total?: number;
    issueDate?: string;
    excludeDocumentId?: string;
  },
): Promise<DuplicateBillWarning[]> {
  const warnings: DuplicateBillWarning[] = [];
  const ref = input.referenceNumber?.trim();
  if (ref) {
    let query = supabase
      .from("teller_documents")
      .select("id, number, status")
      .eq("organization_id", input.organizationId)
      .eq("kind", "bill")
      .eq("party_id", input.partyId)
      .eq("reference_number", ref)
      .not("status", "eq", "void");
    if (input.excludeDocumentId) query = query.neq("id", input.excludeDocumentId);
    const { data } = await query;
    if ((data ?? []).length) {
      warnings.push({
        level: "high",
        message: `Another bill already uses vendor invoice #${ref} for this vendor.`,
        documentIds: (data ?? []).map((row) => row.id as string),
      });
    }
  }

  const total = asNumber(input.total);
  const issueDate = input.issueDate;
  if (total > 0 && issueDate) {
    const start = new Date(`${issueDate}T00:00:00`);
    start.setDate(start.getDate() - 7);
    const end = new Date(`${issueDate}T00:00:00`);
    end.setDate(end.getDate() + 7);
    let query = supabase
      .from("teller_documents")
      .select("id, number")
      .eq("organization_id", input.organizationId)
      .eq("kind", "bill")
      .eq("party_id", input.partyId)
      .gte("issue_date", start.toISOString().slice(0, 10))
      .lte("issue_date", end.toISOString().slice(0, 10))
      .eq("total", total)
      .not("status", "eq", "void");
    if (input.excludeDocumentId) query = query.neq("id", input.excludeDocumentId);
    const { data } = await query;
    if ((data ?? []).length) {
      warnings.push({
        level: "medium",
        message: `Another bill for this vendor has the same amount and a nearby date.`,
        documentIds: (data ?? []).map((row) => row.id as string),
      });
    }
  }

  return warnings;
}
