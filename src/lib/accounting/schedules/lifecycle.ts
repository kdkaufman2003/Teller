import type { ScheduleStatus } from "./types";

export type LifecycleAction = "activate" | "pause" | "resume" | "cancel";

const ALLOWED: Record<ScheduleStatus, ScheduleStatus[]> = {
  draft: ["active", "cancelled"],
  active: ["paused", "cancelled", "completed"],
  paused: ["active", "cancelled"],
  completed: [],
  cancelled: [],
};

export function assertLifecycleTransition(current: ScheduleStatus, next: ScheduleStatus): void {
  if (current === next) return;
  const allowed = ALLOWED[current] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`Cannot transition schedule from ${current} to ${next}`);
  }
}

export function canEditScheduleFields(status: ScheduleStatus): boolean {
  return status === "draft";
}

export function canEditLimitedActiveFields(status: ScheduleStatus): boolean {
  return status === "draft" || status === "paused";
}

export function actionToStatus(action: LifecycleAction): ScheduleStatus | null {
  switch (action) {
    case "activate":
      return "active";
    case "pause":
      return "paused";
    case "resume":
      return "active";
    case "cancel":
      return "cancelled";
    default:
      return null;
  }
}

export function assertOccurrenceAction(
  status: string,
  action: "approve" | "post" | "skip" | "retry" | "reverse",
): void {
  const map: Record<string, string[]> = {
    approve: ["scheduled", "generated"],
    post: ["scheduled", "generated", "approved"],
    skip: ["scheduled", "generated", "approved", "failed"],
    retry: ["failed"],
    reverse: ["posted"],
  };
  const allowed = map[action] ?? [];
  if (!allowed.includes(status)) {
    throw new Error(`Cannot ${action} occurrence in status ${status}`);
  }
}
