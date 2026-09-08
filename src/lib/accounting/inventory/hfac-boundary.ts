import { TELLER_HFAC_ORG_ID } from "@/lib/integration/controlled-prod-test";

export const HFAC_INVENTORY_EVENT_TYPES = [
  "inventory.receipt",
  "inventory.transfer",
  "inventory.issue",
  "inventory.return",
  "inventory.adjustment",
] as const;

export type HfacInventoryEventType = (typeof HFAC_INVENTORY_EVENT_TYPES)[number];

export type HfacInventoryPayload = {
  workOrderId?: string;
  technicianId?: string;
  truckId?: string;
  jobId?: string;
  partId?: string;
  quantity?: number;
  locationId?: string;
};

export function hfacInventoryIntegrationAllowed(): boolean {
  return false;
}

export function assertHfacInventoryHardRefusal(organizationId: string): void {
  if (organizationId === TELLER_HFAC_ORG_ID) {
    throw new Error("Refusing HFAC inventory integration — HFAC is event provider only, not accounting truth");
  }
  if (hfacInventoryIntegrationAllowed()) {
    throw new Error("HFAC inventory integration is not enabled in Phase 13 V1");
  }
}

export function normalizeHfacInventoryPayload(payload: unknown): HfacInventoryPayload {
  if (!payload || typeof payload !== "object") return {};
  const row = payload as Record<string, unknown>;
  return {
    workOrderId: typeof row.work_order_id === "string" ? row.work_order_id : undefined,
    technicianId: typeof row.technician_id === "string" ? row.technician_id : undefined,
    truckId: typeof row.truck_id === "string" ? row.truck_id : undefined,
    jobId: typeof row.job_id === "string" ? row.job_id : undefined,
    partId: typeof row.part_id === "string" ? row.part_id : undefined,
    quantity: typeof row.quantity === "number" ? row.quantity : undefined,
    locationId: typeof row.location_id === "string" ? row.location_id : undefined,
  };
}
