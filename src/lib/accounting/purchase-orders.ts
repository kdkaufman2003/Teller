import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { nextNumber } from "./accounts";
import { loadApSettings, poRequiresApproval } from "./ap-settings";
import { recordAuditEvent } from "./audit";
import {
  PO_TERMINAL_STATUSES,
  PO_TRANSITIONS,
  type PurchaseOrderLineInput,
  type PurchaseOrderStatus,
  type ReceiveLineInput,
} from "./purchase-order-types";

export function assertPoStatusTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): void {
  if (from === to) return;
  const allowed = PO_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid purchase order status transition: ${from} → ${to}`);
  }
}

function roundQty(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function lineAmount(quantity: number, unitCost: number): number {
  return Math.round(quantity * unitCost * 100) / 100;
}

export async function createPurchaseOrder(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    partyId: string;
    jobId?: string | null;
    issueDate: string;
    expectedDate?: string | null;
    shipTo?: string;
    buyerName?: string;
    vendorMessage?: string;
    memo?: string;
    lines: PurchaseOrderLineInput[];
    actorId?: string | null;
  },
) {
  if (!input.lines.length) throw new Error("At least one PO line is required");

  const { data: existing } = await supabase
    .from("teller_purchase_orders")
    .select("number")
    .eq("organization_id", input.organizationId);
  const number = nextNumber("PO", (existing ?? []).map((row) => row.number as string));

  const builtLines = input.lines.map((line, index) => {
    const quantity = roundQty(asNumber(line.quantity, 1));
    const unitCost = asNumber(line.unitCost);
    return {
      description: line.description || "Line item",
      quantity,
      unit_cost: unitCost,
      amount: lineAmount(quantity, unitCost),
      account_id: line.accountId ?? null,
      job_id: line.jobId ?? null,
      cost_category: line.costCategory ?? "",
      cost_type: line.costType ?? "",
      sort_order: line.sortOrder ?? index,
    };
  });

  const subtotal = builtLines.reduce((sum, line) => sum + line.amount, 0);

  const { data: po, error } = await supabase
    .from("teller_purchase_orders")
    .insert({
      organization_id: input.organizationId,
      number,
      party_id: input.partyId,
      job_id: input.jobId ?? null,
      status: "draft",
      issue_date: input.issueDate,
      expected_date: input.expectedDate ?? null,
      ship_to: input.shipTo ?? "",
      buyer_name: input.buyerName ?? "",
      vendor_message: input.vendorMessage ?? "",
      memo: input.memo ?? "",
      subtotal,
      tax: 0,
      total: subtotal,
      created_by: input.actorId ?? null,
    })
    .select("id")
    .single();
  if (error || !po) throw new Error(error?.message || "Could not create purchase order");

  await supabase.from("teller_purchase_order_lines").insert(
    builtLines.map((line) => ({
      ...line,
      organization_id: input.organizationId,
      purchase_order_id: po.id,
    })),
  );

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "purchase_order.created",
    resourceKind: "purchase_order",
    resourceId: po.id as string,
    metadata: { number, total: subtotal },
  });

  return { purchaseOrderId: po.id as string, number };
}

export async function updatePurchaseOrderDraft(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    purchaseOrderId: string;
    partyId?: string;
    jobId?: string | null;
    issueDate?: string;
    expectedDate?: string | null;
    shipTo?: string;
    buyerName?: string;
    vendorMessage?: string;
    memo?: string;
    lines?: PurchaseOrderLineInput[];
    actorId?: string | null;
  },
) {
  const po = await loadPoForUpdate(supabase, input.organizationId, input.purchaseOrderId);
  if (po.status !== "draft") throw new Error("Only draft purchase orders can be edited");

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.partyId) patch.party_id = input.partyId;
  if (input.jobId !== undefined) patch.job_id = input.jobId;
  if (input.issueDate) patch.issue_date = input.issueDate;
  if (input.expectedDate !== undefined) patch.expected_date = input.expectedDate;
  if (input.shipTo !== undefined) patch.ship_to = input.shipTo;
  if (input.buyerName !== undefined) patch.buyer_name = input.buyerName;
  if (input.vendorMessage !== undefined) patch.vendor_message = input.vendorMessage;
  if (input.memo !== undefined) patch.memo = input.memo;

  if (input.lines?.length) {
    const builtLines = input.lines.map((line, index) => {
      const quantity = roundQty(asNumber(line.quantity, 1));
      const unitCost = asNumber(line.unitCost);
      return {
        description: line.description || "Line item",
        quantity,
        unit_cost: unitCost,
        amount: lineAmount(quantity, unitCost),
        account_id: line.accountId ?? null,
        job_id: line.jobId ?? null,
        cost_category: line.costCategory ?? "",
        cost_type: line.costType ?? "",
        sort_order: line.sortOrder ?? index,
      };
    });
    const subtotal = builtLines.reduce((sum, line) => sum + line.amount, 0);
    patch.subtotal = subtotal;
    patch.total = subtotal;

    await supabase
      .from("teller_purchase_order_lines")
      .delete()
      .eq("purchase_order_id", po.id)
      .eq("organization_id", input.organizationId);

    await supabase.from("teller_purchase_order_lines").insert(
      builtLines.map((line) => ({
        ...line,
        organization_id: input.organizationId,
        purchase_order_id: po.id,
      })),
    );
  }

  await supabase.from("teller_purchase_orders").update(patch).eq("id", po.id);
}

export async function closePurchaseOrder(
  supabase: SupabaseClient,
  input: { organizationId: string; purchaseOrderId: string; actorId?: string | null },
) {
  const po = await loadPoForUpdate(supabase, input.organizationId, input.purchaseOrderId);
  assertPoStatusTransition(po.status as PurchaseOrderStatus, "closed");
  await supabase
    .from("teller_purchase_orders")
    .update({ status: "closed", updated_at: new Date().toISOString() })
    .eq("id", po.id);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "document.status_changed",
    resourceKind: "purchase_order",
    resourceId: po.id as string,
    metadata: { from: po.status, to: "closed" },
  });
}

export async function submitPurchaseOrderForApproval(
  supabase: SupabaseClient,
  input: { organizationId: string; purchaseOrderId: string; actorId?: string | null },
) {
  const po = await loadPoForUpdate(supabase, input.organizationId, input.purchaseOrderId);
  const settings = await loadApSettings(supabase, input.organizationId);
  const nextStatus: PurchaseOrderStatus = poRequiresApproval(settings, asNumber(po.total))
    ? "pending_approval"
    : "approved";
  assertPoStatusTransition(po.status as PurchaseOrderStatus, nextStatus);

  await supabase
    .from("teller_purchase_orders")
    .update({
      status: nextStatus,
      submitted_by: input.actorId ?? null,
      submitted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", po.id);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "purchase_order.submitted",
    resourceKind: "purchase_order",
    resourceId: po.id as string,
    metadata: { status: nextStatus },
  });
}

export async function approvePurchaseOrder(
  supabase: SupabaseClient,
  input: { organizationId: string; purchaseOrderId: string; actorId?: string | null },
) {
  const po = await loadPoForUpdate(supabase, input.organizationId, input.purchaseOrderId);
  assertPoStatusTransition(po.status as PurchaseOrderStatus, "approved");
  await supabase
    .from("teller_purchase_orders")
    .update({
      status: "approved",
      approved_by: input.actorId ?? null,
      approved_at: new Date().toISOString(),
      rejection_reason: "",
      updated_at: new Date().toISOString(),
    })
    .eq("id", po.id);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "purchase_order.approved",
    resourceKind: "purchase_order",
    resourceId: po.id as string,
    metadata: {},
  });
}

export async function rejectPurchaseOrder(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    purchaseOrderId: string;
    reason: string;
    actorId?: string | null;
  },
) {
  const po = await loadPoForUpdate(supabase, input.organizationId, input.purchaseOrderId);
  if (po.status !== "pending_approval") {
    throw new Error("Only pending purchase orders can be rejected");
  }
  assertPoStatusTransition("pending_approval", "draft");
  await supabase
    .from("teller_purchase_orders")
    .update({
      status: "draft",
      rejection_reason: input.reason.trim(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", po.id);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "purchase_order.rejected",
    resourceKind: "purchase_order",
    resourceId: po.id as string,
    metadata: { reason: input.reason.trim() },
  });
}

export async function markPurchaseOrderSent(
  supabase: SupabaseClient,
  input: { organizationId: string; purchaseOrderId: string; actorId?: string | null },
) {
  const po = await loadPoForUpdate(supabase, input.organizationId, input.purchaseOrderId);
  assertPoStatusTransition(po.status as PurchaseOrderStatus, "sent");
  await supabase
    .from("teller_purchase_orders")
    .update({ status: "sent", updated_at: new Date().toISOString() })
    .eq("id", po.id);
}

export async function cancelPurchaseOrder(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    purchaseOrderId: string;
    reason?: string;
    actorId?: string | null;
  },
) {
  const po = await loadPoForUpdate(supabase, input.organizationId, input.purchaseOrderId);
  if (PO_TERMINAL_STATUSES.includes(po.status as PurchaseOrderStatus)) {
    throw new Error("Purchase order is already closed or cancelled");
  }
  assertPoStatusTransition(po.status as PurchaseOrderStatus, "cancelled");
  await supabase
    .from("teller_purchase_orders")
    .update({
      status: "cancelled",
      rejection_reason: input.reason?.trim() || po.rejection_reason || "",
      updated_at: new Date().toISOString(),
    })
    .eq("id", po.id);
}

export async function receivePurchaseOrder(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    purchaseOrderId: string;
    receiptDate: string;
    referenceNumber?: string;
    receivedBy?: string;
    location?: string;
    memo?: string;
    lines: ReceiveLineInput[];
    actorId?: string | null;
  },
) {
  if (!input.lines.length) throw new Error("At least one receipt line is required");
  const po = await loadPoForUpdate(supabase, input.organizationId, input.purchaseOrderId);
  if (["draft", "pending_approval", "cancelled", "closed"].includes(po.status as string)) {
    throw new Error(`Purchase order status ${po.status} cannot receive items`);
  }

  const { data: poLines, error: linesError } = await supabase
    .from("teller_purchase_order_lines")
    .select("id, quantity, quantity_received, quantity_billed")
    .eq("organization_id", input.organizationId)
    .eq("purchase_order_id", po.id);
  if (linesError) throw new Error(linesError.message);

  const byId = new Map((poLines ?? []).map((line) => [line.id as string, line]));

  for (const item of input.lines) {
    const line = byId.get(item.purchaseOrderLineId);
    if (!line) throw new Error("Purchase order line not found");
    const qty = roundQty(asNumber(item.quantityReceived));
    if (qty <= 0) throw new Error("Received quantity must be greater than zero");
    const remaining = roundQty(asNumber(line.quantity) - asNumber(line.quantity_received));
    if (qty > remaining + 0.0001) {
      throw new Error(
        `Cannot receive ${qty} — only ${remaining} remaining on line ${item.purchaseOrderLineId}`,
      );
    }
  }

  const { data: receipt, error: receiptError } = await supabase
    .from("teller_purchase_receipts")
    .insert({
      organization_id: input.organizationId,
      purchase_order_id: po.id,
      receipt_date: input.receiptDate,
      reference_number: input.referenceNumber ?? "",
      received_by: input.receivedBy ?? "",
      location: input.location ?? "",
      memo: input.memo ?? "",
      created_by: input.actorId ?? null,
    })
    .select("id")
    .single();
  if (receiptError || !receipt) throw new Error(receiptError?.message || "Could not create receipt");

  await supabase.from("teller_purchase_receipt_lines").insert(
    input.lines.map((item) => ({
      organization_id: input.organizationId,
      receipt_id: receipt.id,
      purchase_order_line_id: item.purchaseOrderLineId,
      quantity_received: roundQty(asNumber(item.quantityReceived)),
    })),
  );

  for (const item of input.lines) {
    const line = byId.get(item.purchaseOrderLineId)!;
    const newReceived = roundQty(asNumber(line.quantity_received) + asNumber(item.quantityReceived));
    await supabase
      .from("teller_purchase_order_lines")
      .update({ quantity_received: newReceived })
      .eq("id", item.purchaseOrderLineId)
      .eq("organization_id", input.organizationId);
  }

  const { data: refreshedLines } = await supabase
    .from("teller_purchase_order_lines")
    .select("quantity, quantity_received")
    .eq("purchase_order_id", po.id);

  const allReceived = (refreshedLines ?? []).every(
    (line) => asNumber(line.quantity_received) + 0.0001 >= asNumber(line.quantity),
  );
  const anyReceived = (refreshedLines ?? []).some((line) => asNumber(line.quantity_received) > 0);
  let nextStatus: PurchaseOrderStatus = po.status as PurchaseOrderStatus;
  if (allReceived) nextStatus = "received";
  else if (anyReceived) nextStatus = "partially_received";
  else if (nextStatus === "approved") nextStatus = "sent";

  if (nextStatus !== po.status) {
    assertPoStatusTransition(po.status as PurchaseOrderStatus, nextStatus);
    await supabase
      .from("teller_purchase_orders")
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq("id", po.id);
  }

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "purchase_order.received",
    resourceKind: "purchase_order",
    resourceId: po.id as string,
    metadata: { receiptId: receipt.id, status: nextStatus },
  });

  return { receiptId: receipt.id as string, status: nextStatus };
}

export async function loadPurchaseOrderDetail(
  supabase: SupabaseClient,
  organizationId: string,
  purchaseOrderId: string,
) {
  const [{ data: po, error }, { data: lines }, { data: receipts }, { data: linkedBills }] =
    await Promise.all([
      supabase
        .from("teller_purchase_orders")
        .select("*, teller_parties(name)")
        .eq("organization_id", organizationId)
        .eq("id", purchaseOrderId)
        .maybeSingle(),
      supabase
        .from("teller_purchase_order_lines")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("purchase_order_id", purchaseOrderId)
        .order("sort_order"),
      supabase
        .from("teller_purchase_receipts")
        .select("*, teller_purchase_receipt_lines(*)")
        .eq("organization_id", organizationId)
        .eq("purchase_order_id", purchaseOrderId)
        .order("receipt_date", { ascending: false }),
      supabase
        .from("teller_documents")
        .select("id, number, status, total, issue_date")
        .eq("organization_id", organizationId)
        .eq("purchase_order_id", purchaseOrderId)
        .eq("kind", "bill"),
    ]);
  if (error) throw new Error(error.message);
  if (!po) throw new Error("Purchase order not found");
  return { po, lines: lines ?? [], receipts: receipts ?? [], linkedBills: linkedBills ?? [] };
}

async function loadPoForUpdate(
  supabase: SupabaseClient,
  organizationId: string,
  purchaseOrderId: string,
) {
  const { data, error } = await supabase
    .from("teller_purchase_orders")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", purchaseOrderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Purchase order not found");
  return data;
}
