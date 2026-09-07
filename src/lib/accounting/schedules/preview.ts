import { buildPrepaidRecognitionPeriods } from "./prepaid";
import type { RecognitionMethod, ScheduleType } from "./types";

export type SchedulePreviewRow = {
  occurrenceDate: string;
  amount: number;
  remainingAfter: number;
  isFinal: boolean;
};

export function buildSchedulePreview(input: {
  scheduleType: ScheduleType;
  startDate: string;
  endDate: string | null;
  originalAmount: number;
  recognitionMethod?: RecognitionMethod;
}): SchedulePreviewRow[] {
  if (!input.endDate) {
    if (input.scheduleType === "accrued_expense") {
      return [
        {
          occurrenceDate: input.startDate.slice(0, 10),
          amount: input.originalAmount,
          remainingAfter: 0,
          isFinal: true,
        },
      ];
    }
    throw new Error("End date is required for recognition preview");
  }

  const periods = buildPrepaidRecognitionPeriods({
    startDate: input.startDate,
    endDate: input.endDate,
    originalAmount: input.originalAmount,
    method: input.recognitionMethod,
  });

  let remaining = input.originalAmount;
  return periods.map((period) => {
    remaining = Math.max(0, Math.round((remaining - period.amount) * 100) / 100);
    return {
      occurrenceDate: period.occurrenceDate,
      amount: period.amount,
      remainingAfter: remaining,
      isFinal: period.isFinal,
    };
  });
}

export function scheduleOccurrenceReviewPath(scheduleId: string, occurrenceId: string): string {
  return `/app/accounting/schedules/${scheduleId}/occurrences/${occurrenceId}`;
}

export function scheduleDetailPath(scheduleId: string): string {
  return `/app/accounting/schedules/${scheduleId}`;
}

export function closeFindingScheduleRoute(input: {
  scheduleId: string;
  occurrenceId?: string | null;
  status?: string;
}): string {
  if (input.occurrenceId) {
    return scheduleOccurrenceReviewPath(input.scheduleId, input.occurrenceId);
  }
  return scheduleDetailPath(input.scheduleId);
}
