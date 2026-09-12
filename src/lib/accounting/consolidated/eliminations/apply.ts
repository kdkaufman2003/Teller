import { roundMoney } from "../../payment-fees";
import { isIntercompanyAccount } from "../grouping";
import type { ConsolidatedTrialBalanceRow } from "../types";
import type { PostedEliminationAdjustment } from "./load-posted";
import { sumEliminationAdjustmentsByGroupKey } from "./load-posted";

export function applyEliminationsToTrialBalanceRows(
  preRows: ConsolidatedTrialBalanceRow[],
  adjustments: PostedEliminationAdjustment[],
): {
  rows: ConsolidatedTrialBalanceRow[];
  eliminationRows: Array<{
    groupKey: string;
    code: string;
    name: string;
    type: string;
    subtype: string;
    eliminationDebit: number;
    eliminationCredit: number;
  }>;
} {
  const byGroup = sumEliminationAdjustmentsByGroupKey(adjustments);
  const rowMap = new Map(preRows.map((row) => [row.groupKey, { ...row }]));
  const eliminationRows: Array<{
    groupKey: string;
    code: string;
    name: string;
    type: string;
    subtype: string;
    eliminationDebit: number;
    eliminationCredit: number;
  }> = [];

  for (const [groupKey, totals] of byGroup.entries()) {
    if (totals.debit === 0 && totals.credit === 0) continue;
    const existing = rowMap.get(groupKey);
    if (existing) {
      existing.adjustedDebit = roundMoney(existing.adjustedDebit + totals.debit);
      existing.adjustedCredit = roundMoney(existing.adjustedCredit + totals.credit);
      existing.netBalance = roundMoney(existing.adjustedDebit - existing.adjustedCredit);
    } else {
      const sampleLine = adjustments.flatMap((adj) => adj.lines).find((line) => line.groupKey === groupKey);
      rowMap.set(groupKey, {
        groupKey,
        code: sampleLine?.accountCode ?? "",
        name: sampleLine?.accountName ?? "",
        type: sampleLine?.accountType ?? "asset",
        subtype: sampleLine?.accountSubtype ?? "",
        adjustedDebit: totals.debit,
        adjustedCredit: totals.credit,
        netBalance: roundMoney(totals.debit - totals.credit),
        isIntercompany: isIntercompanyAccount({ subtype: sampleLine?.accountSubtype }),
        entityContributions: [],
      });
    }
    eliminationRows.push({
      groupKey,
      code: rowMap.get(groupKey)!.code,
      name: rowMap.get(groupKey)!.name,
      type: rowMap.get(groupKey)!.type,
      subtype: rowMap.get(groupKey)!.subtype,
      eliminationDebit: totals.debit,
      eliminationCredit: totals.credit,
    });
  }

  const rows = [...rowMap.values()]
    .filter((row) => row.adjustedDebit !== 0 || row.adjustedCredit !== 0)
    .sort((a, b) => a.code.localeCompare(b.code) || a.type.localeCompare(b.type));

  return { rows, eliminationRows };
}

function eliminationDeltaForAccountType(
  accountType: string,
  debit: number,
  credit: number,
): number {
  const normalized = accountType.toLowerCase();
  if (normalized === "asset" || normalized === "expense") {
    return roundMoney(debit - credit);
  }
  return roundMoney(credit - debit);
}

export function applyEliminationsToFinancialLines<
  T extends {
    groupKey: string;
    code: string;
    name: string;
    amount: number;
    isIntercompany: boolean;
    entityContributions: unknown[];
  },
>(
  preLines: T[],
  adjustments: PostedEliminationAdjustment[],
): T[] {
  const byGroup = sumEliminationAdjustmentsByGroupKey(adjustments);
  const lineMap = new Map(preLines.map((line) => [line.groupKey, { ...line }]));

  for (const [groupKey, totals] of byGroup.entries()) {
    if (totals.debit === 0 && totals.credit === 0) continue;
    const existing = lineMap.get(groupKey);
    const sampleLine = adjustments.flatMap((adj) => adj.lines).find((line) => line.groupKey === groupKey);
    const accountType = sampleLine?.accountType ?? "asset";
    const delta = eliminationDeltaForAccountType(accountType, totals.debit, totals.credit);
    if (existing) {
      existing.amount = roundMoney(existing.amount + delta);
      lineMap.set(groupKey, existing);
    } else if (sampleLine) {
      lineMap.set(groupKey, {
        groupKey,
        code: sampleLine.accountCode,
        name: sampleLine.accountName,
        amount: delta,
        isIntercompany: isIntercompanyAccount({ subtype: sampleLine.accountSubtype }),
        entityContributions: [],
      } as unknown as T);
    }
  }

  return [...lineMap.values()]
    .filter((line) => Math.abs(line.amount) >= 0.005)
    .sort((a, b) => a.code.localeCompare(b.code));
}
