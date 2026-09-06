import type { SupabaseClient } from "@supabase/supabase-js";

export type AllocationIntegrityIssue = {
  table: "teller_payment_allocations" | "teller_document_allocations";
  allocationId: string;
  kind: "missing_cache_pointer" | "orphaned_cache_pointer" | "multiple_reversal_events";
  detail: string;
};

export type AllocationIntegrityReport = {
  consistent: boolean;
  issues: AllocationIntegrityIssue[];
};

type PaymentAllocationRow = {
  id: string;
  reversal_of_allocation_id: string | null;
  reversed_by_allocation_id: string | null;
};

type DocumentAllocationRow = {
  id: string;
  reversal_of_allocation_id: string | null;
  reversed_by_allocation_id: string | null;
};

export function auditAllocationRows(
  table: AllocationIntegrityIssue["table"],
  rows: PaymentAllocationRow[] | DocumentAllocationRow[],
): AllocationIntegrityIssue[] {
  const issues: AllocationIntegrityIssue[] = [];
  const reversalCountByOriginal = new Map<string, number>();

  for (const row of rows) {
    if (row.reversal_of_allocation_id) {
      reversalCountByOriginal.set(
        row.reversal_of_allocation_id,
        (reversalCountByOriginal.get(row.reversal_of_allocation_id) ?? 0) + 1,
      );
    }
  }

  for (const row of rows) {
    if (row.reversal_of_allocation_id) continue;

    const reversalCount = reversalCountByOriginal.get(row.id) ?? 0;

    if (reversalCount > 1) {
      issues.push({
        table,
        allocationId: row.id,
        kind: "multiple_reversal_events",
        detail: `${reversalCount} reversal rows reference this allocation`,
      });
    }

    if (reversalCount > 0 && !row.reversed_by_allocation_id) {
      issues.push({
        table,
        allocationId: row.id,
        kind: "missing_cache_pointer",
        detail: "Reversal event exists but reversed_by_allocation_id cache is null",
      });
    }

    if (row.reversed_by_allocation_id && reversalCount === 0) {
      issues.push({
        table,
        allocationId: row.id,
        kind: "orphaned_cache_pointer",
        detail: `Cache points to ${row.reversed_by_allocation_id} but no reversal event references this allocation`,
      });
    }
  }

  return issues;
}

export async function checkAllocationReversalIntegrity(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<AllocationIntegrityReport> {
  const [{ data: paymentRows, error: paymentError }, { data: documentRows, error: documentError }] =
    await Promise.all([
      supabase
        .from("teller_payment_allocations")
        .select("id, reversal_of_allocation_id, reversed_by_allocation_id")
        .eq("organization_id", organizationId),
      supabase
        .from("teller_document_allocations")
        .select("id, reversal_of_allocation_id, reversed_by_allocation_id")
        .eq("organization_id", organizationId),
    ]);

  if (paymentError) throw new Error(paymentError.message);
  if (documentError) throw new Error(documentError.message);

  const issues = [
    ...auditAllocationRows(
      "teller_payment_allocations",
      (paymentRows ?? []) as PaymentAllocationRow[],
    ),
    ...auditAllocationRows(
      "teller_document_allocations",
      (documentRows ?? []) as DocumentAllocationRow[],
    ),
  ];

  return { consistent: issues.length === 0, issues };
}
