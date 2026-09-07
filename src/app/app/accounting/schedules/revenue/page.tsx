import Link from "next/link";
import { ScheduleListSection } from "@/components/ScheduleViews";
import { DEFERRED_REVENUE_V1_NOTE } from "@/lib/accounting/schedules/deferred-revenue";
import { routes } from "@/lib/routes";

export default function DeferredRevenueSchedulesPage() {
  return (
    <div>
      <ScheduleListSection scheduleType="deferred_revenue" title="Deferred revenue schedules" newType="deferred_revenue" />
      <div className="mx-auto max-w-5xl space-y-3 px-6 pb-6">
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          {DEFERRED_REVENUE_V1_NOTE}
        </p>
        <p className="text-sm text-muted-foreground">
          <strong>Customer deposit</strong> — upfront receipt recorded in Phase 3.{" "}
          <strong>Deferred revenue recognition</strong> — scheduled release from deposit liability.{" "}
          <strong>Invoice revenue</strong> — earned when invoiced, not via this schedule.
        </p>
        <Link className="inline-block text-sm text-muted-foreground hover:underline" href={routes.accountingSchedules}>
          ← All schedules
        </Link>
      </div>
    </div>
  );
}
