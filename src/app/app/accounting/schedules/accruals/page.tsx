import Link from "next/link";
import { ScheduleListSection } from "@/components/ScheduleViews";
import { routes } from "@/lib/routes";

export default function AccrualSchedulesPage() {
  return (
    <div>
      <ScheduleListSection scheduleType="accrued_expense" title="Accrued expense schedules" newType="accrued_expense" />
      <div className="mx-auto max-w-5xl px-6 pb-6">
        <p className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
          Accrual journals estimate expense before the vendor bill arrives. When the bill is posted,
          use <strong>Apply existing accrual</strong> on the bill form to clear accrued liability and
          recognize only the estimate-to-actual variance.
        </p>
        <Link className="mt-4 inline-block text-sm text-muted-foreground hover:underline" href={routes.accountingSchedules}>
          ← All schedules
        </Link>
      </div>
    </div>
  );
}
