import { NextResponse } from "next/server";
import { buildAccrualVarianceReportRows } from "@/lib/accounting/accrual-settlement/reporting";
import { jsonError, requireBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data: settlements, error } = await supabase
    .from("teller_accrual_settlements")
    .select(
      "id, bill_id, settled_at, status, teller_documents(number), teller_accrual_settlement_allocations(occurrence_id, estimated_amount, applied_amount, actual_amount_allocated, variance_amount, teller_schedule_occurrences(occurrence_date, schedule_id, teller_accounting_schedules(name)))",
    )
    .eq("organization_id", organizationId)
    .in("status", ["posted", "settled", "partially_settled"])
    .order("settled_at", { ascending: false });

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({ rows: [], migrationRequired: true });
    }
    return jsonError(error.message, 500);
  }

  const rawRows: Parameters<typeof buildAccrualVarianceReportRows>[0] = [];

  for (const settlement of settlements ?? []) {
    const allocations = (settlement.teller_accrual_settlement_allocations ?? []) as unknown as Array<{
      occurrence_id: string;
      estimated_amount: number;
      applied_amount: number;
      actual_amount_allocated: number;
      variance_amount: number;
      teller_schedule_occurrences?: {
        occurrence_date: string;
        schedule_id: string;
        teller_accounting_schedules?: { name: string };
      };
    }>;
    const bill = settlement.teller_documents as { number?: string } | null;
    for (const allocation of allocations) {
      const occ = allocation.teller_schedule_occurrences;
      rawRows.push({
        occurrenceId: allocation.occurrence_id,
        scheduleId: occ?.schedule_id ?? "",
        scheduleName: occ?.teller_accounting_schedules?.name ?? "Accrual",
        vendorName: null,
        occurrenceDate: occ?.occurrence_date ?? "",
        estimatedAmount: Number(allocation.estimated_amount),
        appliedAmount: Number(allocation.applied_amount),
        actualAmountAllocated: Number(allocation.actual_amount_allocated ?? allocation.applied_amount),
        varianceAmount: Number(allocation.variance_amount ?? 0),
        settlementDate: (settlement.settled_at as string | null) ?? null,
        billId: settlement.bill_id as string,
        billNumber: bill?.number ?? null,
        settlementId: settlement.id as string,
      });
    }
  }

  return NextResponse.json({ rows: buildAccrualVarianceReportRows(rawRows) });
}
