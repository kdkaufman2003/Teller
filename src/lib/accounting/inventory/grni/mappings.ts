export const INVENTORY_ACCOUNT_MAPPING_KEYS = {
  INVENTORY_ASSET: "inventory_asset",
  GRNI_LIABILITY: "grni_liability",
  PURCHASE_PRICE_VARIANCE: "purchase_price_variance",
  COGS: "cogs",
  ADJUSTMENT_EXPENSE: "adjustment_expense",
  ADJUSTMENT_GAIN: "adjustment_gain",
} as const;

export type InventoryAccountMappingKey =
  (typeof INVENTORY_ACCOUNT_MAPPING_KEYS)[keyof typeof INVENTORY_ACCOUNT_MAPPING_KEYS];

export type InventoryAccountMapping = {
  mappingKey: InventoryAccountMappingKey;
  accountId: string;
  required?: boolean;
};

const REQUIRED_KEYS: InventoryAccountMappingKey[] = [
  INVENTORY_ACCOUNT_MAPPING_KEYS.INVENTORY_ASSET,
  INVENTORY_ACCOUNT_MAPPING_KEYS.GRNI_LIABILITY,
  INVENTORY_ACCOUNT_MAPPING_KEYS.PURCHASE_PRICE_VARIANCE,
  INVENTORY_ACCOUNT_MAPPING_KEYS.COGS,
  INVENTORY_ACCOUNT_MAPPING_KEYS.ADJUSTMENT_EXPENSE,
  INVENTORY_ACCOUNT_MAPPING_KEYS.ADJUSTMENT_GAIN,
];

export function validateInventoryAccountMappings(
  mappings: InventoryAccountMapping[],
): { valid: boolean; missing: InventoryAccountMappingKey[] } {
  const byKey = new Map(mappings.map((row) => [row.mappingKey, row.accountId]));
  const missing = REQUIRED_KEYS.filter((key) => !byKey.get(key)?.trim());
  return { valid: missing.length === 0, missing };
}

export function resolveInventoryAccountId(
  mappings: InventoryAccountMapping[],
  key: InventoryAccountMappingKey,
): string {
  const found = mappings.find((row) => row.mappingKey === key);
  if (!found?.accountId) {
    throw new Error(`Missing required inventory account mapping: ${key}`);
  }
  return found.accountId;
}

export function buildDefaultInventoryAccountMappings(input: {
  inventoryAssetAccountId: string;
  grniAccountId: string;
  ppvAccountId: string;
  cogsAccountId: string;
  adjustmentExpenseAccountId: string;
  adjustmentGainAccountId: string;
}): InventoryAccountMapping[] {
  return [
    { mappingKey: INVENTORY_ACCOUNT_MAPPING_KEYS.INVENTORY_ASSET, accountId: input.inventoryAssetAccountId },
    { mappingKey: INVENTORY_ACCOUNT_MAPPING_KEYS.GRNI_LIABILITY, accountId: input.grniAccountId },
    { mappingKey: INVENTORY_ACCOUNT_MAPPING_KEYS.PURCHASE_PRICE_VARIANCE, accountId: input.ppvAccountId },
    { mappingKey: INVENTORY_ACCOUNT_MAPPING_KEYS.COGS, accountId: input.cogsAccountId },
    { mappingKey: INVENTORY_ACCOUNT_MAPPING_KEYS.ADJUSTMENT_EXPENSE, accountId: input.adjustmentExpenseAccountId },
    { mappingKey: INVENTORY_ACCOUNT_MAPPING_KEYS.ADJUSTMENT_GAIN, accountId: input.adjustmentGainAccountId },
  ];
}
