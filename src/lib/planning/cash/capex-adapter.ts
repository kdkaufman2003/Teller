import type { NormalizedCashEvent } from "./cash-event";
import { projectCashEvents } from "./cash-event";
import type { CashFlowLine, CashHorizonWeek } from "./types";

export const CAPEX_OVERRIDE_PREFIX = "capex:";

export function parseOverridePlanningCategory(notes: string): "capex" | "general" {
  const trimmed = notes.trim();
  if (trimmed.startsWith(CAPEX_OVERRIDE_PREFIX)) return "capex";
  try {
    const parsed = JSON.parse(trimmed) as { category?: string };
    if (parsed.category === "capex") return "capex";
  } catch {
    // not JSON
  }
  return "general";
}

export function formatCapexOverrideNotes(notes: string): string {
  const withoutPrefix = notes.startsWith(CAPEX_OVERRIDE_PREFIX)
    ? notes.slice(CAPEX_OVERRIDE_PREFIX.length).trim()
    : notes;
  return withoutPrefix;
}

export function projectCapexCash(input: {
  organizationId: string;
  horizonWeeks: CashHorizonWeek[];
  horizonStart: string;
  horizonEnd: string;
  overrides: Array<{
    id: string;
    effectiveDate: string;
    flowKind: "inflow" | "outflow";
    amount: number;
    label: string;
    notes: string;
  }>;
}): { events: NormalizedCashEvent[]; lines: CashFlowLine[] } {
  const events: NormalizedCashEvent[] = [];

  for (const override of input.overrides) {
    if (parseOverridePlanningCategory(override.notes) !== "capex") continue;
    if (override.flowKind !== "outflow") continue;

    events.push({
      organizationId: input.organizationId,
      sourceType: "capex_plan",
      sourceId: override.id,
      sourceLabel: override.label,
      expectedDate: override.effectiveDate.slice(0, 10),
      amount: override.amount,
      flowKind: "outflow",
      category: "capex",
      dedupeKey: `capex:override:${override.id}`,
      sourceQuality: "planned",
      explanation: `Planned capex — ${override.label}`,
      metadata: {
        notes: formatCapexOverrideNotes(override.notes),
        overrideId: override.id,
      },
    });
  }

  return {
    events,
    lines: projectCashEvents(events, input),
  };
}

/** Depreciation and historical asset purchases are never cash outflows in planning. */
export function depreciationExcludedFromCash(): true {
  return true;
}
