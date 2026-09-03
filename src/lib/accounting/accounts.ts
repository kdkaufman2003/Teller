import type { AccountSeed } from "@/types";

type AccountLookup = {
  id: string;
  code: string;
  type: string;
  subtype?: string;
};

export function accountByCode(accounts: AccountLookup[], code: string) {
  return accounts.find((account) => account.code === code);
}

export function accountBySubtype(accounts: AccountLookup[], subtype: string) {
  return accounts.find((account) => account.subtype === subtype);
}

export const ITEM_TYPE_REVENUE: Record<string, string> = {
  equipment: "4000",
  labor: "4100",
  service: "4200",
  maintenance: "4300",
  parts: "4400",
  warranty: "4500",
  subscription: "4000",
  usage: "4100",
  services: "4200",
  other: "4000",
};

export function revenueCodeForItemType(
  itemType: string,
  accounts: Pick<AccountSeed, "code" | "type">[],
): string {
  const preferred = ITEM_TYPE_REVENUE[itemType] || "4000";
  if (accounts.some((account) => account.code === preferred)) return preferred;
  const firstRevenue = accounts.find((account) => account.type === "revenue");
  return firstRevenue?.code || "4000";
}

export function nextNumber(prefix: string, existing: string[]): string {
  let max = 1000;
  for (const value of existing) {
    const match = value.match(/(\d+)\s*$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${max + 1}`;
}
