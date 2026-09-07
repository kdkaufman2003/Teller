import type { CloseFinding } from "../close-readiness";
import { closeFindingScheduleRoute } from "./preview";

export type ScheduleCloseItem = {
  scheduleId: string;
  occurrenceId?: string | null;
  scheduleName: string;
  scheduleType: string;
  occurrenceDate: string;
  amount: number;
  status: string;
  severity: "blocker" | "warning" | "informational";
};

export function classifyScheduleCloseFinding(
  item: ScheduleCloseItem,
  periodEnd?: string,
): CloseFinding {
  const isFuture =
    periodEnd != null && item.occurrenceDate.slice(0, 10) > periodEnd.slice(0, 10);
  if (isFuture) {
    return {
      key: `schedule_future_${item.scheduleId}`,
      domain: "schedules",
      severity: "informational",
      title: `Future schedule: ${item.scheduleName}`,
      description: `Next occurrence ${item.occurrenceDate} is after close period`,
      route: closeFindingScheduleRoute({
        scheduleId: item.scheduleId,
        occurrenceId: item.occurrenceId,
      }),
    };
  }

  if (item.status === "failed") {
    return {
      key: `schedule_failed_${item.scheduleId}_${item.occurrenceDate}`,
      domain: "schedules",
      severity: "blocker",
      title: `Failed automation: ${item.scheduleName}`,
      description: `Occurrence ${item.occurrenceDate} failed and requires review`,
      route: closeFindingScheduleRoute({
        scheduleId: item.scheduleId,
        occurrenceId: item.occurrenceId,
      }),
    };
  }

  if (item.status === "scheduled" || item.status === "generated" || item.status === "approved") {
    return {
      key: `schedule_due_${item.scheduleId}_${item.occurrenceDate}`,
      domain: "schedules",
      severity: "blocker",
      title: `Schedule due: ${item.scheduleName}`,
      description: `${item.scheduleType} occurrence ${item.occurrenceDate} ($${item.amount.toFixed(2)}) not posted`,
      route: closeFindingScheduleRoute({
        scheduleId: item.scheduleId,
        occurrenceId: item.occurrenceId,
      }),
    };
  }

  return {
    key: `schedule_ok_${item.scheduleId}`,
    domain: "schedules",
    severity: "informational",
    title: item.scheduleName,
    description: "No action required",
    route: closeFindingScheduleRoute({ scheduleId: item.scheduleId }),
  };
}

export function filterDueOnOrBefore(items: ScheduleCloseItem[], periodEnd: string): ScheduleCloseItem[] {
  return items.filter((item) => item.occurrenceDate.slice(0, 10) <= periodEnd.slice(0, 10));
}

export function filterFutureOccurrences(items: ScheduleCloseItem[], periodEnd: string): ScheduleCloseItem[] {
  return items.filter((item) => item.occurrenceDate.slice(0, 10) > periodEnd.slice(0, 10));
}

export type RecurringAutomationCloseItem = {
  kind: "recurring_journal" | "recurring_bill";
  templateId: string;
  name: string;
  dueDate: string;
  status: string;
};

export function recurringAutomationCloseFinding(item: RecurringAutomationCloseItem): CloseFinding {
  if (item.status === "failed") {
    return {
      key: `${item.kind}_failed_${item.templateId}`,
      domain: "schedules",
      severity: "warning",
      title: `Failed ${item.kind.replace("_", " ")}: ${item.name}`,
      description: `Requires review for ${item.dueDate}`,
      route: item.kind === "recurring_journal" ? "/app/accounting/recurring-journals" : "/app/bills",
    };
  }
  return {
    key: `${item.kind}_due_${item.templateId}`,
    domain: "schedules",
    severity: "warning",
    title: `${item.kind === "recurring_journal" ? "Recurring AJE" : "Recurring bill"} due: ${item.name}`,
    description: `Due ${item.dueDate}`,
    route: item.kind === "recurring_journal" ? "/app/accounting/recurring-journals" : "/app/bills",
  };
}
