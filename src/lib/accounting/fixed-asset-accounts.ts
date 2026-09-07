import type { AccountLookup } from "./fixed-asset-types";

export const FIXED_ASSET_SUBTYPES = {
  fixedAsset: "fixed_asset",
  accumulatedDepreciation: "accumulated_depreciation",
  depreciationExpense: "depreciation_expense",
  gainOnDisposal: "gain_on_disposal",
  lossOnDisposal: "loss_on_disposal",
  openingBalanceEquity: "opening_balance_equity",
} as const;

export type FixedAssetSubtype = (typeof FIXED_ASSET_SUBTYPES)[keyof typeof FIXED_ASSET_SUBTYPES];

const SUBTYPE_ACCOUNT_TYPE: Record<FixedAssetSubtype, string> = {
  fixed_asset: "asset",
  accumulated_depreciation: "asset",
  depreciation_expense: "expense",
  gain_on_disposal: "revenue",
  loss_on_disposal: "expense",
  opening_balance_equity: "equity",
};

export function assertFixedAssetAccountCompatibility(
  account: AccountLookup,
  expectedSubtype: FixedAssetSubtype,
): void {
  const expectedType = SUBTYPE_ACCOUNT_TYPE[expectedSubtype];
  if (account.type !== expectedType) {
    throw new Error(
      `Account ${account.code} must be type ${expectedType} for subtype ${expectedSubtype}`,
    );
  }
  if (account.subtype !== expectedSubtype) {
    throw new Error(`Account ${account.code} must have subtype ${expectedSubtype}`);
  }
}

export function accountsBySubtype(accounts: AccountLookup[], subtype: string) {
  return accounts.filter((account) => account.subtype === subtype);
}

export function fixedAssetControlAccountIds(accounts: AccountLookup[]): Set<string> {
  const subtypes = new Set<string>([
    FIXED_ASSET_SUBTYPES.fixedAsset,
    FIXED_ASSET_SUBTYPES.accumulatedDepreciation,
    FIXED_ASSET_SUBTYPES.depreciationExpense,
  ]);
  return new Set(
    accounts.filter((account) => subtypes.has(account.subtype ?? "")).map((account) => account.id),
  );
}

export const DEFAULT_FIXED_ASSET_ACCOUNT_SEEDS = [
  { code: "1500", name: "Fixed Assets", type: "asset" as const, subtype: "fixed_asset" },
  {
    code: "1510",
    name: "Accumulated Depreciation",
    type: "asset" as const,
    subtype: "accumulated_depreciation",
  },
  {
    code: "6800",
    name: "Depreciation Expense",
    type: "expense" as const,
    subtype: "depreciation_expense",
  },
  {
    code: "4900",
    name: "Gain on Asset Disposal",
    type: "revenue" as const,
    subtype: "gain_on_disposal",
  },
  {
    code: "6910",
    name: "Loss on Asset Disposal",
    type: "expense" as const,
    subtype: "loss_on_disposal",
  },
  {
    code: "3900",
    name: "Opening Balance Equity",
    type: "equity" as const,
    subtype: "opening_balance_equity",
  },
];

export const DEFAULT_FIXED_ASSET_CATEGORIES = [
  { code: "vehicles", name: "Vehicles", default_useful_life_months: 60 },
  { code: "machinery", name: "Machinery & Equipment", default_useful_life_months: 84 },
  { code: "tools", name: "Tools & Equipment", default_useful_life_months: 36 },
  { code: "computers", name: "Computer Equipment", default_useful_life_months: 36 },
  { code: "office", name: "Office Equipment", default_useful_life_months: 60 },
  { code: "furniture", name: "Furniture & Fixtures", default_useful_life_months: 84 },
  { code: "buildings", name: "Buildings", default_useful_life_months: 360 },
  { code: "leasehold", name: "Leasehold Improvements", default_useful_life_months: 120 },
  { code: "other", name: "Other Fixed Assets", default_useful_life_months: 60 },
];
