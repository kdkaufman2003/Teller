import type { CashFlowLine } from "./types";

export type CashDedupeDiagnostics = {
  droppedCount: number;
  droppedKeys: string[];
};

function dedupeKey(line: CashFlowLine): string | null {
  const meta = line.metadata as Record<string, unknown> | undefined;
  if (typeof meta?.dedupeKey === "string") return meta.dedupeKey;
  if (line.sourceId) return `${line.sourceKind}:${line.sourceId}`;
  return null;
}

const PRECEDENCE: Record<string, number> = {
  ap_bill: 100,
  ar_invoice: 100,
  payroll_posted: 90,
  payroll_projection: 50,
  recurring_bill_posted: 95,
  recurring_bill: 60,
  recurring_schedule: 55,
  grni_receipt_line: 70,
  po_line_commitment: 40,
  capex_plan: 30,
  manual_override: 20,
};

function precedence(line: CashFlowLine): number {
  return PRECEDENCE[line.sourceKind] ?? 10;
}

/**
 * Collapse overlapping cash events by stable dedupe key, keeping the highest-precedence source.
 */
export function dedupeCashFlowLines(lines: CashFlowLine[]): {
  lines: CashFlowLine[];
  diagnostics: CashDedupeDiagnostics;
} {
  const byKey = new Map<string, CashFlowLine>();
  const droppedKeys: string[] = [];

  for (const line of lines) {
    const key = dedupeKey(line);
    if (!key) {
      byKey.set(`__unique:${byKey.size}`, line);
      continue;
    }

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, line);
      continue;
    }

    if (precedence(line) > precedence(existing)) {
      droppedKeys.push(key);
      byKey.set(key, line);
    } else {
      droppedKeys.push(key);
    }
  }

  return {
    lines: [...byKey.values()],
    diagnostics: {
      droppedCount: droppedKeys.length,
      droppedKeys,
    },
  };
}

export function filterRecurringWhenBillExists(
  lines: CashFlowLine[],
  recurringBillKeys: Set<string>,
): CashFlowLine[] {
  return lines.filter((line) => {
    if (line.sourceKind !== "recurring_bill") return true;
    const key = (line.metadata as Record<string, unknown> | undefined)?.dedupeKey;
    if (typeof key === "string" && recurringBillKeys.has(key)) return false;
    return true;
  });
}

export function filterProjectedPayrollWhenPosted(
  lines: CashFlowLine[],
  postedPayDates: Set<string>,
): CashFlowLine[] {
  return lines.filter((line) => {
    if (line.sourceKind !== "payroll_projection") return true;
    const payDate = (line.metadata as Record<string, unknown> | undefined)?.payDate;
    if (typeof payDate === "string" && postedPayDates.has(payDate.slice(0, 10))) return false;
    return true;
  });
}
