import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";

export type UnassignedJobActivityRow = {
  sourceKind: "bill_line" | "expense_line" | "invoice_line";
  documentId: string;
  documentNumber: string;
  lineId: string;
  description: string;
  amount: number;
  issueDate: string;
};

export async function listUnassignedJobActivity(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<UnassignedJobActivityRow[]> {
  const rows: UnassignedJobActivityRow[] = [];

  const { data: billDocs } = await supabase
    .from("teller_documents")
    .select("id, number, issue_date, kind, status")
    .eq("organization_id", organizationId)
    .in("kind", ["bill", "expense", "invoice"])
    .neq("status", "void");

  const docMap = new Map((billDocs ?? []).map((row) => [row.id as string, row]));
  const docIds = [...docMap.keys()];
  if (!docIds.length) return rows;

  const { data: lines } = await supabase
    .from("teller_document_lines")
    .select("id, document_id, description, amount, job_id, account_id")
    .in("document_id", docIds)
    .is("job_id", null);

  const { data: accounts } = await supabase
    .from("teller_accounts")
    .select("id, type")
    .eq("organization_id", organizationId);
  const accountType = new Map((accounts ?? []).map((row) => [row.id as string, row.type as string]));

  for (const line of lines ?? []) {
    const doc = docMap.get(line.document_id as string);
    if (!doc) continue;
    const kind = doc.kind as string;
    const amount = asNumber(line.amount);
    if (amount <= 0) continue;

    if (kind === "invoice") {
      rows.push({
        sourceKind: "invoice_line",
        documentId: doc.id as string,
        documentNumber: doc.number as string,
        lineId: line.id as string,
        description: line.description as string,
        amount,
        issueDate: doc.issue_date as string,
      });
      continue;
    }

    const acctType = line.account_id ? accountType.get(line.account_id as string) : null;
    if (!acctType || !["cogs", "expense"].includes(acctType)) continue;

    rows.push({
      sourceKind: kind === "bill" ? "bill_line" : "expense_line",
      documentId: doc.id as string,
      documentNumber: doc.number as string,
      lineId: line.id as string,
      description: line.description as string,
      amount,
      issueDate: doc.issue_date as string,
    });
  }

  return rows.sort((a, b) => b.issueDate.localeCompare(a.issueDate));
}
