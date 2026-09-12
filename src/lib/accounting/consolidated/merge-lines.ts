import { roundMoney } from "../payment-fees";
import { consolidationAccountKey, isIntercompanyAccount, mergeContributions } from "./grouping";
import type { ConsolidatedFinancialLine, EntityContribution } from "./types";

export function mergeFinancialSection(
  target: Map<string, ConsolidatedFinancialLine>,
  entity: { legalEntityId: string; name: string; entityCode: string },
  lines: Array<{ code: string; name: string; amount: number }>,
  accounts: Array<{ id: string; code: string; subtype?: string | null; type: string }>,
) {
  const accountByCode = new Map(accounts.map((row) => [row.code, row]));
  for (const line of lines) {
    const account = accountByCode.get(line.code);
    const groupKey = consolidationAccountKey({
      type: account?.type ?? "asset",
      subtype: account?.subtype,
      code: line.code,
      name: line.name,
    });
    const contribution: EntityContribution = {
      legalEntityId: entity.legalEntityId,
      entityName: entity.name,
      entityCode: entity.entityCode,
      amount: line.amount,
      accountId: account?.id,
    };
    const existing = target.get(groupKey);
    if (existing) {
      existing.amount = roundMoney(existing.amount + line.amount);
      existing.entityContributions = mergeContributions(existing.entityContributions, contribution);
      existing.isIntercompany =
        existing.isIntercompany || isIntercompanyAccount({ subtype: account?.subtype });
    } else {
      target.set(groupKey, {
        groupKey,
        code: line.code,
        name: line.name,
        amount: line.amount,
        isIntercompany: isIntercompanyAccount({ subtype: account?.subtype }),
        entityContributions: [contribution],
      });
    }
  }
}
