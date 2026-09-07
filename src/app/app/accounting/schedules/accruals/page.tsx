import Link from "next/link";
import { ScheduleListSection } from "@/components/ScheduleViews";
import { routes } from "@/lib/routes";

export default function AccrualSchedulesPage() {
  return (
    <div>
      <ScheduleListSection scheduleType="accrued_expense" title="Accrued expense schedules" newType="accrued_expense" />
      <div className="mx-auto max-w-5xl px-6 pb-6">
        <p className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
          Creates an accrual journal — this does not create a vendor bill. Actual-bill settlement remains manual for V1.
        </p>
        <Link className="mt-4 inline-block text-sm text-muted-foreground hover:underline" href={routes.accountingSchedules}>
          ← All schedules
        </Link>
      </div>
    </div>
  );
}
