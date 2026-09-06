import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { nextNumber } from "./accounts";
import { recordAuditEvent } from "./audit";
import { assertPoStatusTransition } from "./purchase-orders";
import { PO_TRANSITIONS, type PurchaseOrderStatus } from "./purchase-order-types";

export type PoBillLineInput = {
  purchaseOrderLineId: string;
  quantityToBill: number;
  unitCostOverride?: number | null;
};

export async function convertPurchaseOrderToBill(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    purchaseOrderId: string;
    issueDate: string;
    dueDate?: string;
    referenceNumber?: string;
    memo?: string;
    lines: PoBillLineInput[];
    actorId?: string | null;
    acknowledgePriceVariance?: boolean;
  },
) {
  if (!input.lines.length) throw new Error("Select at least one line to bill");

  const { data: po, error: poError } = await supabase
    .from("teller_purchase_orders")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.purchaseOrderId)
    .maybeSingle();
  if (poError) throw new Error(poError.message);
  if (!po) throw new Error("Purchase order not found");
  if (["draft", "pending_approval", "cancelled"].includes(po.status as string)) {
    throw new Error("Purchase order must be approved before billing");
  }

  const { data: poLines, error: linesError } = await supabase
    .from("teller_purchase_order_lines")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("purchase_order_id", input.purchaseOrderId);
  if (linesError) throw new Error(linesError.message);

  const byId = new Map((poLines ?? []).map((line) => [line.id as string, line]));
  const builtLines: Array<Record<string, unknown>> = [];
  let subtotal = 0;
  const warnings: string[] = [];

  for (const item of input.lines) {
    const line = byId.get(item.purchaseOrderLineId);
    if (!line) throw new Error("PO line not found");
    const qty = Math.round(asNumber(item.quantityToBill) * 10000) / 10000;
    if (qty <= 0) throw new Error("Bill quantity must be greater than zero");

    const received = asNumber(line.quantity_received);
    const billed = asNumber(line.quantity_billed);
    const billable = Math.max(received - billed, 0);
    if (qty > billable + 0.0001) {
      throw new Error(
        `Cannot bill ${qty} on line — only ${billable} billable (received ${received}, billed ${billed})`,
      );
    }

    const unitCost = item.unitCostOverride ?? asNumber(line.unit_cost);
    if (Math.abs(unitCost - asNumber(line.unit_cost)) > 0.009 && !input.acknowledgePriceVariance) {
      warnings.push(
        `Line "${line.description}" unit cost ${unitCost} differs from PO ${asNumber(line.unit_cost)}`,
      );
    }

    const amount = Math.round(qty * unitCost * 100) / 100;
    subtotal += amount;
    builtLines.push({
      description: line.description as string,
      quantity: qty,
      unit_price: unitCost,
      amount,
      account_id: line.account_id,
      job_id: line.job_id,
      cost_category: line.cost_category,
      cost_type: line.cost_type,
      item_type: "expense",
      sort_order: builtLines.length,
    });
  }

  if (warnings.length && !input.acknowledgePriceVariance) {
    throw new Error(`${warnings.join("; ")}. Set acknowledgePriceVariance to proceed.`);
  }

  const { data: existingBills } = await supabase
    .from("teller_documents")
    .select("number")
    .eq("organization_id", input.organizationId)
    .eq("kind", "bill");
  const number = nextNumber("BILL", (existingBills ?? []).map((row) => row.number as string));

  const { data: doc, error: docError } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: input.organizationId,
      kind: "bill",
      number,
      party_id: po.party_id,
      job_id: po.job_id,
      purchase_order_id: po.id,
      status: "draft",
      issue_date: input.issueDate,
      due_date: input.dueDate || input.issueDate,
      subtotal,
      tax: 0,
      total: subtotal,
      memo: input.memo || `From PO ${po.number}`,
      reference_number: input.referenceNumber || "",
      metadata: { purchase_order_id: po.id, purchase_order_number: po.number },
    })
    .select("id")
    .single();
  if (docError || !doc) throw new Error(docError?.message || "Could not create bill");

  const { error: linesInsertError } = await supabase
    .from("teller_document_lines")
    .insert(builtLines.map((line) => ({ ...line, document_id: doc.id })));
  if (linesInsertError) throw new Error(linesInsertError.message);

  for (const item of input.lines) {
    const line = byId.get(item.purchaseOrderLineId)!;
    const newBilled =
      Math.round((asNumber(line.quantity_billed) + asNumber(item.quantityToBill)) * 10000) / 10000;
    await supabase
      .from("teller_purchase_order_lines")
      .update({ quantity_billed: newBilled })
      .eq("id", item.purchaseOrderLineId);
  }

  const { data: refreshed } = await supabase
    .from("teller_purchase_order_lines")
    .select("quantity, quantity_billed")
    .eq("purchase_order_id", po.id);
  const allBilled = (refreshed ?? []).every(
    (line) => asNumber(line.quantity_billed) + 0.0001 >= asNumber(line.quantity),
  );
  const anyBilled = (refreshed ?? []).some((line) => asNumber(line.quantity_billed) > 0);
  let nextStatus: PurchaseOrderStatus = po.status as PurchaseOrderStatus;
  if (allBilled) nextStatus = "billed";
  else if (anyBilled) nextStatus = "partially_billed";

  if (nextStatus !== po.status && (PO_TRANSITIONS[po.status as PurchaseOrderStatus] ?? []).includes(nextStatus)) {
    await supabase
      .from("teller_purchase_orders")
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq("id", po.id);
  }

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "purchase_order.billed",
    resourceKind: "purchase_order",
    resourceId: po.id as string,
    metadata: { billId: doc.id, billNumber: number },
  });

  return { billId: doc.id as string, billNumber: number, warnings };
}
