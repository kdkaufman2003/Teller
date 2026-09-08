import type { SupabaseClient } from "@supabase/supabase-js";
import type { JournalLineInput } from "../post";

function journalLinesPayload(lines: JournalLineInput[]) {
  return lines.map((line) => ({
    account_id: line.account_id,
    debit: line.debit ?? 0,
    credit: line.credit ?? 0,
    party_id: line.party_id ?? null,
    job_id: line.job_id ?? null,
    job_cost_category_id: line.job_cost_category_id ?? null,
    cost_classification: line.cost_classification ?? "",
    fixed_asset_id: line.fixed_asset_id ?? null,
    memo: line.memo ?? "",
  }));
}

function mapRow(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

export async function atomicReceiveInventory(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    inventoryItemId: string;
    locationId: string;
    quantity: number;
    unitCost: number;
    movementType: string;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    entryDate?: string | null;
    journalLines?: JournalLineInput[] | null;
    journalSourceKind?: string | null;
    journalSourceId?: string | null;
    actorId?: string | null;
  },
) {
  const { data, error } = await supabase.rpc("teller_atomic_receive_inventory", {
    p_organization_id: input.organizationId,
    p_inventory_item_id: input.inventoryItemId,
    p_location_id: input.locationId,
    p_quantity: input.quantity,
    p_unit_cost: input.unitCost,
    p_movement_type: input.movementType,
    p_source_type: input.sourceType,
    p_source_id: input.sourceId,
    p_idempotency_key: input.idempotencyKey,
    p_entry_date: input.entryDate ?? null,
    p_journal_lines: input.journalLines ? journalLinesPayload(input.journalLines) : null,
    p_journal_source_kind: input.journalSourceKind ?? null,
    p_journal_source_id: input.journalSourceId ?? null,
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error(error.message);
  const row = mapRow(data);
  return {
    duplicate: Boolean(row.duplicate),
    movementId: String(row.movement_id ?? ""),
    journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : null,
    quantityOnHand: Number(row.quantity_on_hand ?? 0),
    inventoryValue: Number(row.inventory_value ?? 0),
    weightedAverageUnitCost: Number(row.weighted_average_unit_cost ?? 0),
  };
}

export async function atomicIssueInventory(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    inventoryItemId: string;
    locationId: string;
    quantity: number;
    movementType: string;
    idempotencyKey: string;
    jobId?: string | null;
    vendorId?: string | null;
    sourceType?: string | null;
    sourceId?: string | null;
    entryDate?: string | null;
    journalLines?: JournalLineInput[] | null;
    journalSourceKind?: string | null;
    journalSourceId?: string | null;
    issueUnitCost?: number | null;
    actorId?: string | null;
  },
) {
  const { data, error } = await supabase.rpc("teller_atomic_issue_inventory", {
    p_organization_id: input.organizationId,
    p_inventory_item_id: input.inventoryItemId,
    p_location_id: input.locationId,
    p_quantity: input.quantity,
    p_movement_type: input.movementType,
    p_idempotency_key: input.idempotencyKey,
    p_job_id: input.jobId ?? null,
    p_vendor_id: input.vendorId ?? null,
    p_source_type: input.sourceType ?? null,
    p_source_id: input.sourceId ?? null,
    p_entry_date: input.entryDate ?? null,
    p_journal_lines: input.journalLines ? journalLinesPayload(input.journalLines) : null,
    p_journal_source_kind: input.journalSourceKind ?? null,
    p_journal_source_id: input.journalSourceId ?? null,
    p_issue_unit_cost: input.issueUnitCost ?? null,
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error(error.message);
  const row = mapRow(data);
  return {
    duplicate: Boolean(row.duplicate),
    movementId: String(row.movement_id ?? ""),
    journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : null,
    cogsAmount: Number(row.cogs_amount ?? 0),
    unitCostApplied: Number(row.unit_cost_applied ?? 0),
    quantityOnHand: Number(row.quantity_on_hand ?? 0),
    inventoryValue: Number(row.inventory_value ?? 0),
  };
}

export async function atomicTransferInventory(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    inventoryItemId: string;
    fromLocationId: string;
    toLocationId: string;
    quantity: number;
    idempotencyKey: string;
    occurredAt?: string | null;
    actorId?: string | null;
  },
) {
  const { data, error } = await supabase.rpc("teller_atomic_transfer_inventory", {
    p_organization_id: input.organizationId,
    p_inventory_item_id: input.inventoryItemId,
    p_from_location_id: input.fromLocationId,
    p_to_location_id: input.toLocationId,
    p_quantity: input.quantity,
    p_idempotency_key: input.idempotencyKey,
    p_occurred_at: input.occurredAt ?? null,
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error(error.message);
  const row = mapRow(data);
  return {
    duplicate: Boolean(row.duplicate),
    transferGroupId: String(row.transfer_group_id ?? ""),
    outMovementId: row.out_movement_id ? String(row.out_movement_id) : null,
    inMovementId: row.in_movement_id ? String(row.in_movement_id) : null,
    unitCost: Number(row.unit_cost ?? 0),
    extendedCost: Number(row.extended_cost ?? 0),
  };
}

export async function atomicReverseInventoryMovement(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    movementId: string;
    idempotencyKey: string;
    entryDate?: string | null;
    journalLines?: JournalLineInput[] | null;
    actorId?: string | null;
  },
) {
  const { data, error } = await supabase.rpc("teller_atomic_reverse_inventory_movement", {
    p_organization_id: input.organizationId,
    p_movement_id: input.movementId,
    p_idempotency_key: input.idempotencyKey,
    p_entry_date: input.entryDate ?? null,
    p_journal_lines: input.journalLines ? journalLinesPayload(input.journalLines) : null,
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error(error.message);
  const row = mapRow(data);
  return {
    duplicate: Boolean(row.duplicate),
    reversalMovementId: String(row.reversal_movement_id ?? row.movement_id ?? ""),
    journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : null,
  };
}

export async function inventoryAtomicRpcAvailable(supabase: SupabaseClient): Promise<boolean> {
  const { error } = await supabase.rpc("teller_atomic_receive_inventory", {
    p_organization_id: "00000000-0000-0000-0000-000000000000",
    p_inventory_item_id: "00000000-0000-0000-0000-000000000000",
    p_location_id: "00000000-0000-0000-0000-000000000000",
    p_quantity: 1,
    p_unit_cost: 1,
    p_movement_type: "purchase_receipt",
    p_source_type: "probe",
    p_source_id: "00000000-0000-0000-0000-000000000000",
    p_idempotency_key: "probe:availability",
    p_entry_date: null,
    p_journal_lines: null,
    p_journal_source_kind: null,
    p_journal_source_id: null,
    p_actor_id: null,
  });
  if (!error) return true;
  const message = error.message ?? "";
  return !/does not exist|schema cache|could not find the function/i.test(message);
}

export async function atomicSettleInventoryReceiptBill(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    receiptLineId: string;
    billLineId: string;
    billId: string;
    quantityMatched: number;
    receiptUnitCost: number;
    billUnitCost: number;
    idempotencyKey: string;
    entryDate: string;
    journalLines: JournalLineInput[];
    actorId?: string | null;
  },
) {
  const { data, error } = await supabase.rpc("teller_atomic_settle_inventory_receipt_bill", {
    p_organization_id: input.organizationId,
    p_receipt_line_id: input.receiptLineId,
    p_bill_line_id: input.billLineId,
    p_bill_id: input.billId,
    p_quantity_matched: input.quantityMatched,
    p_receipt_unit_cost: input.receiptUnitCost,
    p_bill_unit_cost: input.billUnitCost,
    p_idempotency_key: input.idempotencyKey,
    p_entry_date: input.entryDate,
    p_journal_lines: journalLinesPayload(input.journalLines),
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error(error.message);
  const row = mapRow(data);
  return {
    duplicate: Boolean(row.duplicate),
    allocationId: String(row.allocation_id ?? ""),
    journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : null,
    receiptValueMatched: Number(row.receipt_value_matched ?? 0),
    billValueMatched: Number(row.bill_value_matched ?? 0),
    varianceAmount: Number(row.variance_amount ?? 0),
  };
}

export async function atomicReverseInventoryReceiptBillAllocation(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    allocationId: string;
    idempotencyKey: string;
    entryDate: string;
    journalLines: JournalLineInput[];
    actorId?: string | null;
  },
) {
  const { data, error } = await supabase.rpc("teller_atomic_reverse_inventory_receipt_bill_allocation", {
    p_organization_id: input.organizationId,
    p_allocation_id: input.allocationId,
    p_idempotency_key: input.idempotencyKey,
    p_entry_date: input.entryDate,
    p_journal_lines: journalLinesPayload(input.journalLines),
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error(error.message);
  const row = mapRow(data);
  return {
    duplicate: Boolean(row.duplicate),
    reversalAllocationId: String(row.reversal_allocation_id ?? row.allocation_id ?? ""),
    journalEntryId: row.journal_entry_id ? String(row.journal_entry_id) : null,
  };
}
