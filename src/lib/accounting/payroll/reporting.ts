import { roundMoney } from "../payment-fees";
import { computePayrollTotals } from "./journal-lines";
import type { PayrollComponentInput } from "./types";
import { allocateEmployerBurden } from "./labor-allocation";

export type PayrollSummaryRow = {
  periodStart: string;
  periodEnd: string;
  grossWages: number;
  employerTaxes: number;
  employeeWithholdings: number;
  netPay: number;
  totalEmployerLaborCost: number;
};

export function buildPayrollSummary(input: {
  periodStart: string;
  periodEnd: string;
  components: PayrollComponentInput[];
}): PayrollSummaryRow {
  const totals = computePayrollTotals(input.components);
  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    grossWages: totals.grossWages,
    employerTaxes: totals.employerTaxes,
    employeeWithholdings: roundMoney(totals.employeeTaxes + totals.employeeDeductions),
    netPay: totals.netPay,
    totalEmployerLaborCost: roundMoney(totals.grossWages + totals.employerTaxes),
  };
}

export type PayrollLiabilityRollforward = {
  beginningLiability: number;
  newLiability: number;
  payments: number;
  adjustments: number;
  endingLiability: number;
};

export function buildPayrollLiabilityRollforward(input: {
  beginningLiability: number;
  newLiability: number;
  payments: number;
  adjustments?: number;
}): PayrollLiabilityRollforward {
  const adjustments = roundMoney(input.adjustments ?? 0);
  const endingLiability = roundMoney(
    input.beginningLiability + input.newLiability - input.payments + adjustments,
  );
  return {
    beginningLiability: roundMoney(input.beginningLiability),
    newLiability: roundMoney(input.newLiability),
    payments: roundMoney(input.payments),
    adjustments,
    endingLiability,
  };
}

export type LaborByJobRow = {
  jobId: string;
  jobNumber: string;
  revenue: number;
  grossLabor: number;
  employerBurden: number;
  totalLabor: number;
  laborPercentOfRevenue: number | null;
  grossProfitAfterLabor: number;
};

export function buildLaborByJobReport(input: {
  jobs: Array<{ jobId: string; jobNumber: string; revenue: number }>;
  laborAllocations: Array<{ jobId: string | null; grossAmount: number; laborType: string }>;
  employerBurdenTotal: number;
}): LaborByJobRow[] {
  const burdenRows = allocateEmployerBurden({
    totalEmployerBurden: input.employerBurdenTotal,
    destinations: input.laborAllocations.map((row, index) => ({
      key: `${row.jobId ?? "none"}:${index}`,
      jobId: row.jobId,
      laborType: "direct",
      grossAmount: row.grossAmount,
    })),
  });

  const burdenByJob = new Map<string, number>();
  for (const row of burdenRows) {
    if (!row.jobId) continue;
    burdenByJob.set(row.jobId, roundMoney((burdenByJob.get(row.jobId) ?? 0) + row.burdenAmount));
  }

  return input.jobs.map((job) => {
    const grossLabor = roundMoney(
      input.laborAllocations
        .filter((row) => row.jobId === job.jobId && row.laborType === "direct")
        .reduce((sum, row) => sum + row.grossAmount, 0),
    );
    const employerBurden = burdenByJob.get(job.jobId) ?? 0;
    const totalLabor = roundMoney(grossLabor + employerBurden);
    const laborPercentOfRevenue =
      job.revenue > 0.009 ? roundMoney((totalLabor / job.revenue) * 100) : null;
    return {
      jobId: job.jobId,
      jobNumber: job.jobNumber,
      revenue: job.revenue,
      grossLabor,
      employerBurden,
      totalLabor,
      laborPercentOfRevenue,
      grossProfitAfterLabor: roundMoney(job.revenue - totalLabor),
    };
  });
}

export type LaborByWorkerRow = {
  workerId: string;
  displayName: string;
  hours: number;
  grossWages: number;
  directLabor: number;
  indirectLabor: number;
  employerBurden: number;
};

export type UnallocatedLaborRow = {
  workerId: string;
  displayName: string;
  periodStart: string;
  periodEnd: string;
  grossAmount: number;
  unallocatedAmount: number;
  reason: string;
};

export function buildUnallocatedLaborReport(input: {
  workerId: string;
  displayName: string;
  periodStart: string;
  periodEnd: string;
  grossAmount: number;
  unallocatedAmount: number;
  reason?: string;
}): UnallocatedLaborRow {
  return {
    workerId: input.workerId,
    displayName: input.displayName,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    grossAmount: input.grossAmount,
    unallocatedAmount: input.unallocatedAmount,
    reason: input.reason ?? "No job assignment",
  };
}

export function buildAccountantPayrollPackage(input: {
  summary: PayrollSummaryRow;
  liabilityRollforward: PayrollLiabilityRollforward;
  jobLaborReconciliationDifference: number;
  unallocatedRows: UnallocatedLaborRow[];
}) {
  return {
    payrollSummary: input.summary,
    liabilityRollforward: input.liabilityRollforward,
    jobLaborReconciliationDifference: input.jobLaborReconciliationDifference,
    unallocatedLabor: input.unallocatedRows,
  };
}
