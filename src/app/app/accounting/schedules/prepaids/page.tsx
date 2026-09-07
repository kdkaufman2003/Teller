import { ScheduleListSection } from "@/components/ScheduleViews";

export default function PrepaidSchedulesPage() {
  return (
    <ScheduleListSection
      scheduleType="prepaid_expense"
      title="Prepaid expense schedules"
      newType="prepaid_expense"
    />
  );
}
