import { roundMoney } from "../payment-fees";

export const INVENTORY_ITEM_TYPES = {
  INVENTORY: "inventory",
  NON_INVENTORY: "non_inventory",
  SERVICE: "service",
} as const;

export type InventoryItemType = (typeof INVENTORY_ITEM_TYPES)[keyof typeof INVENTORY_ITEM_TYPES];

export const INVENTORY_LOCATION_TYPES = {
  WAREHOUSE: "warehouse",
  VEHICLE: "vehicle",
  STAGING: "staging",
  OTHER: "other",
} as const;

export type InventoryLocationType =
  (typeof INVENTORY_LOCATION_TYPES)[keyof typeof INVENTORY_LOCATION_TYPES];

export const INVENTORY_MOVEMENT_TYPES = {
  PURCHASE_RECEIPT: "purchase_receipt",
  TRANSFER_OUT: "transfer_out",
  TRANSFER_IN: "transfer_in",
  JOB_ISSUE: "job_issue",
  JOB_RETURN: "job_return",
  VENDOR_RETURN: "vendor_return",
  ADJUSTMENT_IN: "adjustment_in",
  ADJUSTMENT_OUT: "adjustment_out",
  OPENING_BALANCE: "opening_balance",
  REVERSAL: "reversal",
} as const;

export type InventoryMovementType =
  (typeof INVENTORY_MOVEMENT_TYPES)[keyof typeof INVENTORY_MOVEMENT_TYPES];

export const INVENTORY_VALUATION_METHODS = {
  WEIGHTED_AVERAGE: "weighted_average",
} as const;

export type InventoryValuationMethod =
  (typeof INVENTORY_VALUATION_METHODS)[keyof typeof INVENTORY_VALUATION_METHODS];

export const INVENTORY_COUNT_STATUSES = {
  DRAFT: "draft",
  IN_PROGRESS: "in_progress",
  REVIEWED: "reviewed",
  POSTED: "posted",
  CANCELLED: "cancelled",
} as const;

export type InventoryCountStatus =
  (typeof INVENTORY_COUNT_STATUSES)[keyof typeof INVENTORY_COUNT_STATUSES];

export const INVENTORY_ADJUSTMENT_REASONS = {
  COUNT_CORRECTION: "count_correction",
  DAMAGE: "damage",
  SHRINKAGE: "shrinkage",
  FOUND: "found",
  WRITE_OFF: "write_off",
  OTHER: "other",
} as const;

export type InventoryAdjustmentReason =
  (typeof INVENTORY_ADJUSTMENT_REASONS)[keyof typeof INVENTORY_ADJUSTMENT_REASONS];

export type InventoryItemInput = {
  sku: string;
  name: string;
  description?: string;
  itemType?: InventoryItemType;
  unitOfMeasure?: string;
  inventoryAssetAccountId: string;
  cogsAccountId: string;
  purchaseAccountId?: string | null;
  valuationMethod?: InventoryValuationMethod;
  active?: boolean;
};

export type InventoryBalanceState = {
  quantityOnHand: number;
  inventoryValue: number;
  weightedAverageUnitCost: number;
};

export type InventoryMovementInput = {
  organizationId: string;
  inventoryItemId: string;
  locationId: string;
  movementType: InventoryMovementType;
  quantityDelta: number;
  unitCost: number;
  sourceType?: string | null;
  sourceId?: string | null;
  jobId?: string | null;
  vendorId?: string | null;
  transferGroupId?: string | null;
  idempotencyKey: string;
  occurredAt?: string;
};

export function inventoryReceiptIdempotencyKey(sourceType: string, sourceId: string): string {
  return `inventory:receipt:${sourceType}:${sourceId}`;
}

export function inventoryIssueIdempotencyKey(jobId: string, itemId: string, operationId: string): string {
  return `inventory:issue:${jobId}:${itemId}:${operationId}`;
}

export function inventoryTransferIdempotencyKey(transferGroupId: string, leg: "out" | "in"): string {
  return `inventory:transfer:${transferGroupId}:${leg}`;
}

export function inventoryAdjustmentIdempotencyKey(operationId: string): string {
  return `inventory:adjustment:${operationId}`;
}

export function inventoryCountPostIdempotencyKey(countId: string): string {
  return `inventory:count:${countId}`;
}

export function assertInventoryQuantity(quantity: number): void {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("Inventory quantity must be positive");
  }
}

export function assertSufficientStock(available: number, requested: number, allowNegative = false): void {
  if (allowNegative) return;
  if (requested - available > 0.0001) {
    throw new Error(`Insufficient inventory: available ${roundMoney(available)}, requested ${roundMoney(requested)}`);
  }
}

export function isInventoryEconomicMovement(type: InventoryMovementType): boolean {
  return ![
    INVENTORY_MOVEMENT_TYPES.TRANSFER_OUT,
    INVENTORY_MOVEMENT_TYPES.TRANSFER_IN,
  ].includes(type as typeof INVENTORY_MOVEMENT_TYPES.TRANSFER_OUT);
}

/** GRNI purchase flow: receipt Dr Inventory / Cr GRNI; bill settlement Dr GRNI / Cr AP. */
export const PHASE13_RECEIPT_ACCOUNTING_MODEL =
  "receipt_dr_inventory_cr_grni_bill_dr_grni_cr_ap_v1" as const;
