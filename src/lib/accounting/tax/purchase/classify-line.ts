import type { PurchaseLineClassification } from "./types";

export function classifyPurchaseLine(input: {
  accountType?: string | null;
  costType?: string | null;
  itemType?: string | null;
}): PurchaseLineClassification {
  const costType = (input.costType ?? "").toLowerCase();
  const itemType = (input.itemType ?? "").toLowerCase();
  const accountType = (input.accountType ?? "").toLowerCase();

  if (accountType === "fixed_asset" || costType === "fixed_asset" || itemType === "fixed_asset") {
    return "fixed_asset";
  }
  if (
    costType === "inventory" ||
    itemType === "inventory" ||
    accountType === "inventory" ||
    (accountType === "asset" && costType !== "expense")
  ) {
    return "inventory";
  }
  if (accountType === "expense" || accountType === "cogs" || costType === "expense") {
    return "expense";
  }
  return "other";
}
