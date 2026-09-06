export type PurchaseOrderStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "sent"
  | "partially_received"
  | "received"
  | "partially_billed"
  | "billed"
  | "closed"
  | "cancelled";

export const PO_TERMINAL_STATUSES: PurchaseOrderStatus[] = ["closed", "cancelled"];

export const PO_TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  draft: ["pending_approval", "approved", "cancelled"],
  pending_approval: ["approved", "draft", "cancelled"],
  approved: ["sent", "partially_received", "received", "cancelled"],
  sent: ["partially_received", "received", "cancelled"],
  partially_received: ["received", "partially_billed", "billed", "closed", "cancelled"],
  received: ["partially_billed", "billed", "closed"],
  partially_billed: ["billed", "closed"],
  billed: ["closed"],
  closed: [],
  cancelled: [],
};

export type PurchaseOrderLineInput = {
  description: string;
  quantity: number;
  unitCost: number;
  accountId?: string | null;
  jobId?: string | null;
  costCategory?: string;
  costType?: string;
  sortOrder?: number;
};

export type ReceiveLineInput = {
  purchaseOrderLineId: string;
  quantityReceived: number;
};

export const COST_TYPES = [
  "material",
  "equipment",
  "subcontractor",
  "labor_external",
  "permit",
  "freight",
  "rental",
  "other",
] as const;

export type CostType = (typeof COST_TYPES)[number];
