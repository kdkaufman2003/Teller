import { roundMoney } from "@/lib/accounting/payment-fees";
import type { CashFlowKind, CashFlowLine, CashHorizonWeek, CashLineCategory } from "./types";
import { bucketDateIntoHorizon } from "./weeks";

export type CashSourceQuality = "confirmed" | "scheduled" | "planned";

export type NormalizedCashEvent = {
  organizationId: string;
  sourceType: string;
  sourceId: string;
  sourceLabel: string;
  expectedDate: string;
  amount: number;
  flowKind: CashFlowKind;
  category: CashLineCategory;
  dedupeKey: string;
  sourceQuality: CashSourceQuality;
  explanation: string;
  drilldownPath?: string;
  overdue?: boolean;
  unscheduled?: boolean;
  metadata?: Record<string, unknown>;
};

export function cashEventToFlowLine(
  event: NormalizedCashEvent,
  input: {
    horizonWeeks: CashHorizonWeek[];
    horizonStart: string;
    horizonEnd: string;
  },
): CashFlowLine {
  const bucket = bucketDateIntoHorizon(
    event.expectedDate,
    input.horizonStart,
    input.horizonEnd,
    input.horizonWeeks,
  );

  const overdue = event.overdue ?? bucket.kind === "overdue";
  const weekIndex =
    bucket.kind === "week"
      ? bucket.weekIndex
      : bucket.kind === "overdue"
        ? 1
        : null;
  const week =
    weekIndex != null ? input.horizonWeeks.find((w) => w.weekIndex === weekIndex) : null;

  return {
    weekIndex,
    periodStart: week?.periodStart ?? null,
    periodEnd: week?.periodEnd ?? null,
    flowKind: event.flowKind,
    category: event.category,
    amount: roundMoney(event.amount),
    sourceKind: event.sourceType,
    sourceId: event.sourceId,
    label: event.sourceLabel,
    explanation: event.explanation,
    overdue,
    beyondHorizon: bucket.kind === "beyond",
    metadata: {
      ...event.metadata,
      dedupeKey: event.dedupeKey,
      sourceQuality: event.sourceQuality,
      drilldownPath: event.drilldownPath,
      unscheduled: event.unscheduled ?? false,
    },
  };
}

export function projectCashEvents(
  events: NormalizedCashEvent[],
  input: {
    horizonWeeks: CashHorizonWeek[];
    horizonStart: string;
    horizonEnd: string;
  },
): CashFlowLine[] {
  return events.map((event) => cashEventToFlowLine(event, input));
}
