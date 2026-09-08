import { roundMoney } from "../payment-fees";
import type { InventoryBalanceState } from "./types";

export type InventoryValuationRow = {
  itemId: string;
  sku: string;
  name: string;
  quantityOnHand: number;
  averageCost: number;
  totalValue: number;
};

export type InventoryByLocationRow = {
  locationId: string;
  locationName: string;
  itemId: string;
  sku: string;
  quantityOnHand: number;
  totalValue: number;
};

export type InventoryMovementReportRow = {
  occurredAt: string;
  itemSku: string;
  locationName: string;
  movementType: string;
  quantity: number;
  unitCost: number;
  extendedCost: number;
  sourceType: string | null;
  jobId: string | null;
};

export type JobMaterialUsageRow = {
  jobId: string;
  itemSku: string;
  quantity: number;
  cost: number;
};

export function buildInventoryValuationSummary(
  items: Array<{ id: string; sku: string; name: string }>,
  balances: Array<{ inventoryItemId: string } & InventoryBalanceState>,
): InventoryValuationRow[] {
  const byItem = new Map<string, InventoryValuationRow>();

  for (const item of items) {
    byItem.set(item.id, {
      itemId: item.id,
      sku: item.sku,
      name: item.name,
      quantityOnHand: 0,
      averageCost: 0,
      totalValue: 0,
    });
  }

  for (const balance of balances) {
    const row = byItem.get(balance.inventoryItemId);
    if (!row) continue;
    row.quantityOnHand = roundMoney(row.quantityOnHand + balance.quantityOnHand);
    row.totalValue = roundMoney(row.totalValue + balance.inventoryValue);
  }

  for (const row of byItem.values()) {
    row.averageCost =
      row.quantityOnHand <= 0.0001 ? 0 : roundMoney(row.totalValue / row.quantityOnHand);
  }

  return [...byItem.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}

export function buildInventoryByLocationReport(
  locations: Array<{ id: string; name: string }>,
  items: Array<{ id: string; sku: string }>,
  balances: Array<{
    inventoryItemId: string;
    locationId: string;
    quantityOnHand: number;
    inventoryValue: number;
  }>,
): InventoryByLocationRow[] {
  const locationMap = new Map(locations.map((row) => [row.id, row.name]));
  const itemMap = new Map(items.map((row) => [row.id, row.sku]));

  return balances
    .map((row) => ({
      locationId: row.locationId,
      locationName: locationMap.get(row.locationId) ?? row.locationId,
      itemId: row.inventoryItemId,
      sku: itemMap.get(row.inventoryItemId) ?? row.inventoryItemId,
      quantityOnHand: roundMoney(row.quantityOnHand),
      totalValue: roundMoney(row.inventoryValue),
    }))
    .sort((a, b) => a.locationName.localeCompare(b.locationName) || a.sku.localeCompare(b.sku));
}

export function buildJobMaterialUsageReport(
  movements: Array<{
    jobId: string | null;
    itemSku: string;
    quantityDelta: number;
    extendedCost: number;
    movementType: string;
  }>,
): JobMaterialUsageRow[] {
  const rows = new Map<string, JobMaterialUsageRow>();

  for (const movement of movements) {
    if (!movement.jobId) continue;
    if (movement.movementType !== "job_issue" && movement.movementType !== "job_return") continue;
    const key = `${movement.jobId}:${movement.itemSku}`;
    const existing = rows.get(key) ?? {
      jobId: movement.jobId,
      itemSku: movement.itemSku,
      quantity: 0,
      cost: 0,
    };
    if (movement.movementType === "job_issue") {
      existing.quantity = roundMoney(existing.quantity + Math.abs(movement.quantityDelta));
      existing.cost = roundMoney(existing.cost + movement.extendedCost);
    } else {
      existing.quantity = roundMoney(existing.quantity - Math.abs(movement.quantityDelta));
      existing.cost = roundMoney(existing.cost - movement.extendedCost);
    }
    rows.set(key, existing);
  }

  return [...rows.values()].sort((a, b) => a.jobId.localeCompare(b.jobId));
}

export type AccountantInventoryPackage = {
  valuation: InventoryValuationRow[];
  reconciliationDifference: number;
  adjustmentCount: number;
  movementCount: number;
};

export function buildAccountantInventoryPackage(input: {
  valuation: InventoryValuationRow[];
  reconciliationDifference: number;
  adjustments: unknown[];
  movements: unknown[];
}): AccountantInventoryPackage {
  return {
    valuation: input.valuation,
    reconciliationDifference: roundMoney(input.reconciliationDifference),
    adjustmentCount: input.adjustments.length,
    movementCount: input.movements.length,
  };
}

export const OWNER_MODE_INVENTORY_LABELS = {
  inventoryValue: "Inventory Value",
  partsOnHand: "Parts on Hand",
  partsUsedOnJobs: "Parts Used on Jobs",
  inventoryAdjustments: "Inventory Adjustments",
  inventoryByLocation: "Inventory by Location",
} as const;

export const ACCOUNTANT_MODE_INVENTORY_LABELS = {
  inventoryAsset: "Inventory Asset",
  cogs: "COGS",
  adjustmentExpense: "Adjustment Expense",
  glReconciliation: "GL Reconciliation",
  weightedAverageCost: "Weighted Average Cost",
} as const;
