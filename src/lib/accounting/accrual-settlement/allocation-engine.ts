import { roundMoney } from "../payment-fees";
import {
  resolveLineTaxAttribution,
  type TaxableBillLine,
  type ResolvedLineTaxAttribution,
} from "./tax-attribution";

export type SettlementBillLine = TaxableBillLine;

export type AccrualAllocationRequest = {
  occurrenceId: string;
  appliedAmount: number;
  actualAmountAllocated?: number;
  liabilityAccountId: string;
  expenseAccountId: string;
};

export type ResolvedAccrualAllocation = {
  occurrenceId: string;
  appliedAmount: number;
  actualPreTaxAllocated: number;
  nonrecoverableTaxAllocated: number;
  recoverableTaxAllocated: number;
  actualAmountAllocated: number;
  varianceAmount: number;
  liabilityAccountId: string;
  expenseAccountId: string;
};

export type SettlementEconomics = {
  billSubtotal: number;
  purchaseTaxAmount: number;
  billTotal: number;
  accrualSettlementPortion: number;
  newExpensePortion: number;
  purchaseTaxPortion: number;
  accrualAllocations: ResolvedAccrualAllocation[];
  newExpenseDebits: Array<{ accountId: string; amount: number; memo?: string }>;
  recoverableTaxDebits: Array<{ accountId: string; amount: number; memo?: string }>;
  lineTaxAttribution: ResolvedLineTaxAttribution[];
};

export function proportionalActualAllocation(input: {
  settlementPortion: number;
  allocations: Array<{ occurrenceId: string; appliedAmount: number }>;
}): Map<string, number> {
  const map = new Map<string, number>();
  const appliedTotal = roundMoney(input.allocations.reduce((sum, row) => sum + row.appliedAmount, 0));
  if (appliedTotal <= 0) return map;

  let assigned = 0;
  for (let index = 0; index < input.allocations.length; index += 1) {
    const row = input.allocations[index];
    if (index === input.allocations.length - 1) {
      map.set(row.occurrenceId, roundMoney(input.settlementPortion - assigned));
    } else {
      const share = roundMoney((row.appliedAmount / appliedTotal) * input.settlementPortion);
      map.set(row.occurrenceId, share);
      assigned = roundMoney(assigned + share);
    }
  }
  return map;
}

function distributeProportionalAmount(
  target: Map<string, number>,
  amount: number,
  allocations: AccrualAllocationRequest[],
) {
  const shares = proportionalActualAllocation({
    settlementPortion: roundMoney(amount),
    allocations: allocations.map((row) => ({
      occurrenceId: row.occurrenceId,
      appliedAmount: row.appliedAmount,
    })),
  });
  for (const allocation of allocations) {
    const share = shares.get(allocation.occurrenceId) ?? 0;
    target.set(
      allocation.occurrenceId,
      roundMoney((target.get(allocation.occurrenceId) ?? 0) + share),
    );
  }
}

export function computeSettlementEconomics(input: {
  billLines: SettlementBillLine[];
  taxAmount: number;
  accrualAllocations: AccrualAllocationRequest[];
  recoverableInputTaxAccountId?: string | null;
}): SettlementEconomics {
  const billLines = input.billLines.map((line, index) => ({
    ...line,
    lineKey: line.lineKey ?? `line-${index}`,
  }));
  const billSubtotal = roundMoney(billLines.reduce((sum, line) => sum + line.amount, 0));
  const purchaseTaxAmount = roundMoney(input.taxAmount);
  const billTotal = roundMoney(billSubtotal + purchaseTaxAmount);
  const hasAccrualAllocations = input.accrualAllocations.length > 0;

  const lineTaxAttribution = resolveLineTaxAttribution({
    billLines,
    totalTaxAmount: purchaseTaxAmount,
    hasAccrualAllocations,
    recoverableInputTaxAccountId: input.recoverableInputTaxAccountId,
  });

  const subtotalByOccurrence = new Map<string, number>();
  const nonrecoverableTaxByOccurrence = new Map<string, number>();
  const recoverableTaxByOccurrence = new Map<string, number>();

  for (const line of lineTaxAttribution.filter((row) => row.isSettlementLine)) {
    if (line.occurrenceId) {
      subtotalByOccurrence.set(
        line.occurrenceId,
        roundMoney((subtotalByOccurrence.get(line.occurrenceId) ?? 0) + line.subtotal),
      );
      nonrecoverableTaxByOccurrence.set(
        line.occurrenceId,
        roundMoney((nonrecoverableTaxByOccurrence.get(line.occurrenceId) ?? 0) + line.nonrecoverableTax),
      );
      recoverableTaxByOccurrence.set(
        line.occurrenceId,
        roundMoney((recoverableTaxByOccurrence.get(line.occurrenceId) ?? 0) + line.recoverableTax),
      );
    } else {
      distributeProportionalAmount(subtotalByOccurrence, line.subtotal, input.accrualAllocations);
      distributeProportionalAmount(nonrecoverableTaxByOccurrence, line.nonrecoverableTax, input.accrualAllocations);
      distributeProportionalAmount(recoverableTaxByOccurrence, line.recoverableTax, input.accrualAllocations);
    }
  }

  for (const allocation of input.accrualAllocations) {
    if (allocation.actualAmountAllocated != null) {
      subtotalByOccurrence.set(allocation.occurrenceId, roundMoney(allocation.actualAmountAllocated));
    }
  }

  const mappedSubtotal = roundMoney([...subtotalByOccurrence.values()].reduce((sum, value) => sum + value, 0));
  const settlementSubtotalTotal = roundMoney(
    lineTaxAttribution.filter((row) => row.isSettlementLine).reduce((sum, row) => sum + row.subtotal, 0),
  );

  if (mappedSubtotal <= 0 && settlementSubtotalTotal <= 0 && hasAccrualAllocations) {
    const newExpenseSubtotal = roundMoney(
      lineTaxAttribution.filter((row) => !row.isSettlementLine).reduce((sum, row) => sum + row.subtotal, 0),
    );
    distributeProportionalAmount(
      subtotalByOccurrence,
      roundMoney(billSubtotal - newExpenseSubtotal),
      input.accrualAllocations,
    );
    const settlementTaxTotal = roundMoney(
      lineTaxAttribution
        .filter((row) => row.isSettlementLine)
        .reduce((sum, row) => sum + row.nonrecoverableTax, 0),
    );
    const settlementRecoverableTaxTotal = roundMoney(
      lineTaxAttribution
        .filter((row) => row.isSettlementLine)
        .reduce((sum, row) => sum + row.recoverableTax, 0),
    );
    distributeProportionalAmount(nonrecoverableTaxByOccurrence, settlementTaxTotal, input.accrualAllocations);
    distributeProportionalAmount(recoverableTaxByOccurrence, settlementRecoverableTaxTotal, input.accrualAllocations);
  }

  const resolvedAccruals: ResolvedAccrualAllocation[] = input.accrualAllocations.map((allocation) => {
    const appliedAmount = roundMoney(allocation.appliedAmount);
    const actualPreTaxAllocated = roundMoney(subtotalByOccurrence.get(allocation.occurrenceId) ?? 0);
    const nonrecoverableTaxAllocated = roundMoney(
      nonrecoverableTaxByOccurrence.get(allocation.occurrenceId) ?? 0,
    );
    const recoverableTaxAllocated = roundMoney(recoverableTaxByOccurrence.get(allocation.occurrenceId) ?? 0);
    const actualAmountAllocated = roundMoney(actualPreTaxAllocated + nonrecoverableTaxAllocated);
    return {
      occurrenceId: allocation.occurrenceId,
      appliedAmount,
      actualPreTaxAllocated,
      nonrecoverableTaxAllocated,
      recoverableTaxAllocated,
      actualAmountAllocated,
      varianceAmount: roundMoney(actualAmountAllocated - appliedAmount),
      liabilityAccountId: allocation.liabilityAccountId,
      expenseAccountId: allocation.expenseAccountId,
    };
  });

  const newExpenseDebitsMap = new Map<string, number>();
  const recoverableTaxDebitsMap = new Map<string, number>();

  for (const line of lineTaxAttribution.filter((row) => !row.isSettlementLine)) {
    newExpenseDebitsMap.set(
      line.accountId,
      roundMoney((newExpenseDebitsMap.get(line.accountId) ?? 0) + line.subtotal + line.nonrecoverableTax),
    );
    if (line.recoverableTax > 0 && input.recoverableInputTaxAccountId) {
      recoverableTaxDebitsMap.set(
        input.recoverableInputTaxAccountId,
        roundMoney((recoverableTaxDebitsMap.get(input.recoverableInputTaxAccountId) ?? 0) + line.recoverableTax),
      );
    }
  }

  for (const allocation of resolvedAccruals) {
    if (allocation.recoverableTaxAllocated > 0 && input.recoverableInputTaxAccountId) {
      recoverableTaxDebitsMap.set(
        input.recoverableInputTaxAccountId,
        roundMoney(
          (recoverableTaxDebitsMap.get(input.recoverableInputTaxAccountId) ?? 0) +
            allocation.recoverableTaxAllocated,
        ),
      );
    }
  }

  const newExpenseDebits = [...newExpenseDebitsMap.entries()].map(([accountId, amount]) => ({
    accountId,
    amount,
    memo: "Bill expense",
  }));
  const recoverableTaxDebits = [...recoverableTaxDebitsMap.entries()].map(([accountId, amount]) => ({
    accountId,
    amount,
    memo: "Recoverable input tax",
  }));

  const accrualSettlementPortion = roundMoney(
    resolvedAccruals.reduce(
      (sum, row) => sum + row.actualAmountAllocated + row.recoverableTaxAllocated,
      0,
    ),
  );
  const newExpensePortion = roundMoney(newExpenseDebits.reduce((sum, row) => sum + row.amount, 0));
  const recoverableTaxPortion = roundMoney(recoverableTaxDebits.reduce((sum, row) => sum + row.amount, 0));

  const economicsTotal = roundMoney(
    resolvedAccruals.reduce((sum, row) => sum + row.actualAmountAllocated, 0) +
      newExpensePortion +
      recoverableTaxPortion,
  );

  if (Math.abs(economicsTotal - billTotal) > 0.02) {
    throw new Error(
      `Settlement economics (${economicsTotal.toFixed(2)}) must equal bill total (${billTotal.toFixed(2)})`,
    );
  }

  return {
    billSubtotal,
    purchaseTaxAmount,
    billTotal,
    accrualSettlementPortion,
    newExpensePortion,
    purchaseTaxPortion: purchaseTaxAmount,
    accrualAllocations: resolvedAccruals,
    newExpenseDebits,
    recoverableTaxDebits,
    lineTaxAttribution,
  };
}
