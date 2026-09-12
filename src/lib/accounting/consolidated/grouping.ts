import { roundMoney } from "../payment-fees";
import type { EntityContribution } from "./types";

/** Normalize account names so equivalent COA labels group across entities. */
export function normalizeConsolidationAccountName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Cross-entity grouping key — never uses database account IDs.
 * Includes normalized name so unrelated accounts that share type/subtype/code stay separate.
 */
export function consolidationAccountKey(input: {
  type: string;
  subtype?: string | null;
  code: string;
  name: string;
}): string {
  return `${input.type}|${input.subtype ?? ""}|${input.code}|${normalizeConsolidationAccountName(input.name)}`;
}

export function isIntercompanyAccount(input: { subtype?: string | null }): boolean {
  return input.subtype === "due_from" || input.subtype === "due_to";
}

export function mergeContributions(
  existing: EntityContribution[],
  contribution: EntityContribution,
): EntityContribution[] {
  const next = [...existing];
  const index = next.findIndex((row) => row.legalEntityId === contribution.legalEntityId);
  if (index >= 0) {
    next[index] = {
      ...next[index],
      amount: roundMoney(next[index].amount + contribution.amount),
    };
  } else {
    next.push(contribution);
  }
  return next.sort((a, b) => a.entityName.localeCompare(b.entityName));
}

export function sumContributions(contributions: EntityContribution[]): number {
  return roundMoney(contributions.reduce((sum, row) => sum + row.amount, 0));
}
