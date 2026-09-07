import { roundMoney } from "../payment-fees";

export type RollforwardLine = {
  label: string;
  amount: number;
};

export type ScheduleRollforward = {
  scheduleType: string;
  controlAccountId: string;
  beginning: number;
  additions: number;
  recognized: number;
  reversals: number;
  ending: number;
  glBalance: number;
  difference: number;
  lines: RollforwardLine[];
};

export function buildPrepaidRollforward(input: {
  controlAccountId: string;
  beginningPrepaid: number;
  additions: number;
  recognized: number;
  glBalance: number;
}): ScheduleRollforward {
  const beginning = roundMoney(input.beginningPrepaid);
  const additions = roundMoney(input.additions);
  const recognized = roundMoney(input.recognized);
  const ending = roundMoney(beginning + additions - recognized);
  const glBalance = roundMoney(input.glBalance);
  return {
    scheduleType: "prepaid_expense",
    controlAccountId: input.controlAccountId,
    beginning,
    additions,
    recognized,
    reversals: 0,
    ending,
    glBalance,
    difference: roundMoney(ending - glBalance),
    lines: [
      { label: "Beginning prepaid", amount: beginning },
      { label: "Additions", amount: additions },
      { label: "Recognized", amount: -recognized },
      { label: "Ending prepaid", amount: ending },
    ],
  };
}

export function buildAccrualRollforward(input: {
  controlAccountId: string;
  beginningAccrual: number;
  newAccruals: number;
  settlements: number;
  glBalance: number;
}): ScheduleRollforward {
  const beginning = roundMoney(input.beginningAccrual);
  const newAccruals = roundMoney(input.newAccruals);
  const settlements = roundMoney(input.settlements);
  const ending = roundMoney(beginning + newAccruals - settlements);
  const glBalance = roundMoney(input.glBalance);
  return {
    scheduleType: "accrued_expense",
    controlAccountId: input.controlAccountId,
    beginning,
    additions: newAccruals,
    recognized: settlements,
    reversals: settlements,
    ending,
    glBalance,
    difference: roundMoney(ending - glBalance),
    lines: [
      { label: "Beginning accrual", amount: beginning },
      { label: "New accruals", amount: newAccruals },
      { label: "Settlements/reversals", amount: -settlements },
      { label: "Ending accrual", amount: ending },
    ],
  };
}

export function buildDeferredRevenueRollforward(input: {
  controlAccountId: string;
  beginningDeferred: number;
  receipts: number;
  recognized: number;
  glBalance: number;
}): ScheduleRollforward {
  const beginning = roundMoney(input.beginningDeferred);
  const receipts = roundMoney(input.receipts);
  const recognized = roundMoney(input.recognized);
  const ending = roundMoney(beginning + receipts - recognized);
  const glBalance = roundMoney(input.glBalance);
  return {
    scheduleType: "deferred_revenue",
    controlAccountId: input.controlAccountId,
    beginning,
    additions: receipts,
    recognized,
    reversals: 0,
    ending,
    glBalance,
    difference: roundMoney(ending - glBalance),
    lines: [
      { label: "Beginning deferred revenue", amount: beginning },
      { label: "Deposits/receipts", amount: receipts },
      { label: "Recognized", amount: -recognized },
      { label: "Ending deferred revenue", amount: ending },
    ],
  };
}
