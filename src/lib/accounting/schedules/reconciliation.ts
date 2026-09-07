import { roundMoney } from "../payment-fees";

export type ScheduleReconciliationRow = {
  scheduleId: string;
  scheduleName: string;
  scheduleType: string;
  subledgerRemaining: number;
  assignedToControl: boolean;
};

export type ScheduleGlReconciliation = {
  controlAccountId: string;
  controlAccountCode: string;
  scheduleType: string;
  subledgerTotal: number;
  glBalance: number;
  difference: number;
  assigned: ScheduleReconciliationRow[];
  unassignedGlAmount: number;
};

export function reconcileScheduleSubledgerToGl(input: {
  controlAccountId: string;
  controlAccountCode: string;
  scheduleType: string;
  schedules: ScheduleReconciliationRow[];
  glBalance: number;
}): ScheduleGlReconciliation {
  const subledgerTotal = roundMoney(
    input.schedules.reduce((sum, row) => sum + roundMoney(row.subledgerRemaining), 0),
  );
  const glBalance = roundMoney(input.glBalance);
  const difference = roundMoney(subledgerTotal - glBalance);
  const unassignedGlAmount = difference !== 0 ? difference : 0;

  return {
    controlAccountId: input.controlAccountId,
    controlAccountCode: input.controlAccountCode,
    scheduleType: input.scheduleType,
    subledgerTotal,
    glBalance,
    difference,
    assigned: input.schedules,
    unassignedGlAmount,
  };
}

export function detectReconciliationDifference(recon: ScheduleGlReconciliation): boolean {
  return Math.abs(recon.difference) > 0.009;
}
