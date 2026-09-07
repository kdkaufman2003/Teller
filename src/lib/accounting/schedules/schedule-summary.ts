import type { SupabaseClient } from "@supabase/supabase-js";

export type ScheduleHubSummary = {
  activePrepaids: number;
  activeAccruals: number;
  activeDeferredRevenue: number;
  dueThisPeriod: number;
  overdue: number;
  needsReview: number;
  failed: number;
};

export async function buildScheduleHubSummary(
  supabase: SupabaseClient,
  organizationId: string,
  asOfDate: string,
): Promise<ScheduleHubSummary> {
  const asOf = asOfDate.slice(0, 10);

  const { data: schedules, error } = await supabase
    .from("teller_accounting_schedules")
    .select("id, schedule_type, status, next_occurrence_date")
    .eq("organization_id", organizationId)
    .in("status", ["active", "paused"]);

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) {
      return {
        activePrepaids: 0,
        activeAccruals: 0,
        activeDeferredRevenue: 0,
        dueThisPeriod: 0,
        overdue: 0,
        needsReview: 0,
        failed: 0,
      };
    }
    throw new Error(error.message);
  }

  const active = schedules ?? [];
  const countType = (type: string) =>
    active.filter((row) => row.schedule_type === type && row.status === "active").length;

  const { data: occurrences } = await supabase
    .from("teller_schedule_occurrences")
    .select("id, occurrence_date, status, period_end")
    .eq("organization_id", organizationId)
    .in("status", ["scheduled", "generated", "approved", "failed"]);

  const occ = occurrences ?? [];
  const monthStart = `${asOf.slice(0, 7)}-01`;

  return {
    activePrepaids: countType("prepaid_expense"),
    activeAccruals: countType("accrued_expense"),
    activeDeferredRevenue: countType("deferred_revenue"),
    dueThisPeriod: occ.filter(
      (row) =>
        row.occurrence_date >= monthStart &&
        row.occurrence_date <= asOf &&
        ["scheduled", "generated", "approved"].includes(row.status as string),
    ).length,
    overdue: occ.filter(
      (row) =>
        row.occurrence_date < asOf && ["scheduled", "generated", "approved"].includes(row.status as string),
    ).length,
    needsReview: occ.filter((row) => ["generated", "approved"].includes(row.status as string)).length,
    failed: occ.filter((row) => row.status === "failed").length,
  };
}
