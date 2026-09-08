import { roundMoney } from "../payment-fees";
import type { PayrollRunPreview } from "./types";

export type PayrollCloseFinding = {
  key: string;
  severity: "blocker" | "warning" | "informational";
  title: string;
  description: string;
  route?: string;
  difference?: number;
};

export function classifyUnpostedPayrollFinding(input: {
  periodEnd: string;
  runs: Array<{ payDate: string; status: string; id: string }>;
}): PayrollCloseFinding | null {
  const unposted = input.runs.filter(
    (row) =>
      row.payDate <= input.periodEnd &&
      ["imported", "reviewed", "needs_review", "draft"].includes(row.status),
  );
  if (!unposted.length) return null;
  return {
    key: "payroll_unposted",
    severity: "blocker",
    title: "Payroll run not posted",
    description: `${unposted.length} payroll run(s) for this period require posting before close.`,
    route: "/app/accounting/payroll/runs",
  };
}

export function classifyMissingMappingFinding(preview: Pick<PayrollRunPreview, "missingMappings">): PayrollCloseFinding | null {
  if (!preview.missingMappings.length) return null;
  return {
    key: "payroll_missing_mapping",
    severity: "blocker",
    title: "Payroll account mapping missing",
    description: `Missing mappings: ${preview.missingMappings.join(", ")}`,
    route: "/app/accounting/payroll/mappings",
  };
}

export function classifyPayrollReconciliationFinding(input: {
  difference: number;
}): PayrollCloseFinding | null {
  if (Math.abs(input.difference) <= 0.009) return null;
  return {
    key: "payroll_unreconciled",
    severity: "blocker",
    title: "Payroll reconciliation difference",
    description: `Payroll run economics differ from posted journal by ${input.difference.toFixed(2)}.`,
    route: "/app/accounting/payroll/reconciliation",
    difference: input.difference,
  };
}

export function classifyStaleClearingFinding(input: {
  clearingBalance: number;
  asOfDate: string;
  latestPayDate?: string | null;
}): PayrollCloseFinding | null {
  if (input.clearingBalance <= 0.009) return null;
  return {
    key: "payroll_stale_clearing",
    severity: "warning",
    title: "Payroll clearing balance outstanding",
    description: `Payroll clearing balance of ${input.clearingBalance.toFixed(2)} remains open as of ${input.asOfDate}.`,
    route: "/app/accounting/payroll/liabilities",
    difference: input.clearingBalance,
  };
}

export function classifyLegitimateLiabilityFinding(input: {
  liabilityBalance: number;
  dueWithinDays?: number;
}): PayrollCloseFinding | null {
  if (input.liabilityBalance <= 0.009) return null;
  return {
    key: "payroll_current_liability",
    severity: "informational",
    title: "Current payroll liabilities",
    description: `Payroll liabilities of ${input.liabilityBalance.toFixed(2)} remain payable${input.dueWithinDays ? ` within ${input.dueWithinDays} days` : ""}.`,
    route: "/app/accounting/payroll/liabilities",
  };
}

export function classifyUnallocatedLaborFinding(input: {
  unallocatedGross: number;
  grossWages: number;
  thresholdPercent?: number;
}): PayrollCloseFinding | null {
  const threshold = input.thresholdPercent ?? 25;
  if (input.grossWages <= 0.009 || input.unallocatedGross <= 0.009) return null;
  const pct = roundMoney((input.unallocatedGross / input.grossWages) * 100);
  if (pct < threshold) return null;
  return {
    key: "payroll_high_unallocated_labor",
    severity: "warning",
    title: "High unallocated direct labor",
    description: `${pct.toFixed(1)}% of payroll gross wages are unallocated to jobs.`,
    route: "/app/reports/unallocated-labor",
    difference: input.unallocatedGross,
  };
}

export function evaluatePayrollCloseFindings(input: {
  periodEnd: string;
  runs: Array<{ payDate: string; status: string; id: string }>;
  previews: PayrollRunPreview[];
  reconciliationDifference: number;
  clearingBalance: number;
  liabilityBalance: number;
}): PayrollCloseFinding[] {
  const findings: PayrollCloseFinding[] = [];
  const unposted = classifyUnpostedPayrollFinding({ periodEnd: input.periodEnd, runs: input.runs });
  if (unposted) findings.push(unposted);

  for (const preview of input.previews) {
    const mapping = classifyMissingMappingFinding(preview);
    if (mapping) findings.push(mapping);
  }

  const recon = classifyPayrollReconciliationFinding({ difference: input.reconciliationDifference });
  if (recon) findings.push(recon);

  const clearing = classifyStaleClearingFinding({
    clearingBalance: input.clearingBalance,
    asOfDate: input.periodEnd,
  });
  if (clearing) findings.push(clearing);

  const liability = classifyLegitimateLiabilityFinding({ liabilityBalance: input.liabilityBalance });
  if (liability) findings.push(liability);

  for (const preview of input.previews) {
    const unalloc = classifyUnallocatedLaborFinding({
      unallocatedGross: preview.laborSummary.unassignedGross,
      grossWages: preview.grossWages,
    });
    if (unalloc) findings.push(unalloc);
  }

  return findings;
}
