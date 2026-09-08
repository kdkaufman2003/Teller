import { roundMoney } from "../payment-fees";
import type { PayrollJournalLine } from "./journal-lines";
import type { PayrollComponentInput } from "./types";
import { computePayrollTotals } from "./journal-lines";
import { summarizeLaborAllocations } from "./labor-allocation";

export type PayrollGlReconciliation = {
  wageExpenseGl: number;
  wageExpenseRun: number;
  employerTaxExpenseGl: number;
  employerTaxExpenseRun: number;
  liabilityGl: number;
  liabilityRun: number;
  clearingGl: number;
  clearingRun: number;
  difference: number;
  balanced: boolean;
};

export function reconcilePayrollRunToJournal(input: {
  components: PayrollComponentInput[];
  journalLines: PayrollJournalLine[];
  wageExpenseAccountId: string;
  employerTaxExpenseAccountId: string;
  liabilityAccountIds: string[];
  clearingAccountId: string;
}): PayrollGlReconciliation {
  const totals = computePayrollTotals(input.components);

  function sumForAccounts(accountIds: string[], side: "debit" | "credit") {
    return roundMoney(
      input.journalLines
        .filter((row) => accountIds.includes(row.accountId))
        .reduce((sum, row) => sum + (side === "debit" ? row.debit : row.credit), 0),
    );
  }

  const wageExpenseGl = sumForAccounts([input.wageExpenseAccountId], "debit");
  const employerTaxExpenseGl = sumForAccounts([input.employerTaxExpenseAccountId], "debit");
  const liabilityGl = sumForAccounts(input.liabilityAccountIds, "credit");
  const clearingGl = sumForAccounts([input.clearingAccountId], "credit");

  const difference = roundMoney(
    wageExpenseGl +
      employerTaxExpenseGl -
      totals.grossWages -
      totals.employerTaxes +
      (liabilityGl + clearingGl - totals.totalLiability),
  );

  return {
    wageExpenseGl,
    wageExpenseRun: totals.grossWages,
    employerTaxExpenseGl,
    employerTaxExpenseRun: totals.employerTaxes,
    liabilityGl,
    liabilityRun: roundMoney(totals.employeeTaxes + totals.employeeDeductions),
    clearingGl,
    clearingRun: totals.netPay,
    difference,
    balanced: Math.abs(difference) <= 0.009,
  };
}

export type JobLaborReconciliation = {
  totalPayrollLabor: number;
  jobAssignedLabor: number;
  nonJobLabor: number;
  difference: number;
  balanced: boolean;
};

export function reconcileJobLaborEconomics(input: {
  grossWages: number;
  laborAllocations: Array<{ grossAmount: number; jobId?: string | null }>;
}): JobLaborReconciliation {
  const summary = summarizeLaborAllocations(
    input.laborAllocations.map((row) => ({
      workerId: "worker",
      jobId: row.jobId ?? null,
      workDate: "2026-01-01",
      grossAmount: row.grossAmount,
      laborType: row.jobId ? "direct" : "unallocated",
    })),
  );

  const totalPayrollLabor = roundMoney(input.grossWages);
  const jobAssignedLabor = roundMoney(summary.directGross + summary.indirectGross);
  const nonJobLabor = roundMoney(summary.unallocatedGross);
  const difference = roundMoney(totalPayrollLabor - jobAssignedLabor - nonJobLabor);

  return {
    totalPayrollLabor,
    jobAssignedLabor,
    nonJobLabor,
    difference,
    balanced: Math.abs(difference) <= 0.05,
  };
}

export function reconcilePayrollClearingBalance(input: {
  clearingCredits: number;
  settlementDebits: number;
}): { remainingClearing: number; balanced: boolean } {
  const remainingClearing = roundMoney(input.clearingCredits - input.settlementDebits);
  return { remainingClearing, balanced: remainingClearing >= -0.009 };
}
