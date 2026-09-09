import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { roundMoney } from "@/lib/accounting/payment-fees";
import {
  computeOpenReceiptValue,
} from "@/lib/accounting/inventory/grni/settlement";
import type { NormalizedCashEvent } from "./cash-event";
import { projectCashEvents } from "./cash-event";
import { resolveApPaymentDate, type PartyTimingOverrides } from "./timing";
import { addCalendarDays } from "./weeks";
import type { CashFlowLine, CashHorizonWeek } from "./types";
import type { OpenPayable } from "./ap-adapter";

const OPEN_PO_STATUSES = ["approved", "sent", "partially_received", "received", "partially_billed"];

function receiptLineOpenValue(input: {
  quantityReceived: number;
  quantityMatched: number;
  extendedCost: number;
  valueMatched: number;
  unitCost: number;
}): number {
  const receiptValue =
    input.extendedCost > 0.009
      ? input.extendedCost
      : roundMoney(input.quantityReceived * input.unitCost);
  return computeOpenReceiptValue({
    receiptLineId: "synthetic",
    quantityReceived: input.quantityReceived,
    quantityMatched: input.quantityMatched,
    receiptValue,
    valueMatched: input.valueMatched,
  });
}

export async function loadPurchasingCashEvents(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    asOfDate: string;
    horizonEnd: string;
    defaultApDays: number;
    partyOverrides: PartyTimingOverrides;
    openPayables: OpenPayable[];
  },
): Promise<{
  events: NormalizedCashEvent[];
  unscheduledCount: number;
}> {
  const events: NormalizedCashEvent[] = [];
  let unscheduledCount = 0;

  const { data: receiptLines, error: receiptError } = await supabase
    .from("teller_purchase_receipt_lines")
    .select("id, quantity_received, quantity_matched, extended_cost, value_matched, unit_cost, purchase_order_line_id, receipt_id")
    .eq("organization_id", organizationId);
  if (receiptError) throw new Error(receiptError.message);

  const receiptIds = [...new Set((receiptLines ?? []).map((row) => row.receipt_id as string))];
  const poLineIds = [...new Set((receiptLines ?? []).map((row) => row.purchase_order_line_id as string))];

  const receiptById = new Map<string, { receipt_date: string; purchase_order_id: string; id: string }>();
  if (receiptIds.length) {
    const { data: receipts, error } = await supabase
      .from("teller_purchase_receipts")
      .select("id, receipt_date, purchase_order_id")
      .eq("organization_id", organizationId)
      .in("id", receiptIds);
    if (error) throw new Error(error.message);
    for (const receipt of receipts ?? []) {
      receiptById.set(receipt.id as string, receipt as { receipt_date: string; purchase_order_id: string; id: string });
    }
  }

  const poLineUnitCost = new Map<string, number>();
  if (poLineIds.length) {
    const { data: poLines, error } = await supabase
      .from("teller_purchase_order_lines")
      .select("id, unit_cost")
      .eq("organization_id", organizationId)
      .in("id", poLineIds);
    if (error) throw new Error(error.message);
    for (const line of poLines ?? []) {
      poLineUnitCost.set(line.id as string, asNumber(line.unit_cost));
    }
  }

  for (const row of receiptLines ?? []) {
    const receipt = receiptById.get(row.receipt_id as string);
    if (!receipt) continue;

    const unitCost = asNumber(row.unit_cost) || poLineUnitCost.get(row.purchase_order_line_id as string) || 0;
    const openValue = receiptLineOpenValue({
      quantityReceived: asNumber(row.quantity_received),
      quantityMatched: asNumber(row.quantity_matched),
      extendedCost: asNumber(row.extended_cost),
      valueMatched: asNumber(row.value_matched),
      unitCost,
    });
    if (openValue <= 0.009) continue;

    const receiptDate = receipt.receipt_date.slice(0, 10);
    const timing = resolveApPaymentDate({
      issueDate: receiptDate,
      dueDate: null,
      partyId: null,
      defaultApDays: input.defaultApDays,
      partyOverrides: input.partyOverrides,
    });

    events.push({
      organizationId,
      sourceType: "grni_receipt_line",
      sourceId: row.id as string,
      sourceLabel: "Received purchase awaiting bill",
      expectedDate: timing.date,
      amount: openValue,
      flowKind: "outflow",
      category: "purchasing",
      dedupeKey: `grni:line:${row.id as string}`,
      sourceQuality: "confirmed",
      explanation: `Purchasing — received awaiting bill — ${receiptDate}`,
      drilldownPath: `/app/purchasing/receipts/${receipt.id}`,
      metadata: {
        purchaseOrderId: receipt.purchase_order_id,
        poLineId: row.purchase_order_line_id,
        receiptDate,
      },
    });
  }

  const { data: poLines, error: poLineError } = await supabase
    .from("teller_purchase_order_lines")
    .select(`
      id,
      purchase_order_id,
      quantity,
      quantity_received,
      quantity_billed,
      unit_cost,
      amount,
      teller_purchase_orders!inner (
        id,
        number,
        status,
        expected_date,
        issue_date,
        party_id,
        organization_id
      )
    `)
    .eq("organization_id", organizationId);
  if (poLineError) throw new Error(poLineError.message);

  for (const line of poLines ?? []) {
    const poRow = line.teller_purchase_orders;
    const po = (Array.isArray(poRow) ? poRow[0] : poRow) as {
      id: string;
      number: string;
      status: string;
      expected_date: string | null;
      issue_date: string;
      party_id: string | null;
    };
    if (!po) continue;
    if (!OPEN_PO_STATUSES.includes(po.status)) continue;

    const qty = asNumber(line.quantity);
    const received = asNumber(line.quantity_received);
    const openQty = roundMoney(Math.max(0, qty - received));
    if (openQty <= 0.0001) continue;

    const unitCost = asNumber(line.unit_cost);
    const openAmount = roundMoney(openQty * unitCost);
    if (openAmount <= 0.009) continue;

    if (!po.expected_date) {
      unscheduledCount += 1;
      events.push({
        organizationId,
        sourceType: "po_line_commitment",
        sourceId: line.id as string,
        sourceLabel: `PO #${po.number}`,
        expectedDate: input.asOfDate,
        amount: openAmount,
        flowKind: "outflow",
        category: "purchasing",
        dedupeKey: `po:line:${line.id as string}`,
        sourceQuality: "planned",
        explanation: `Purchasing — unscheduled commitment — PO #${po.number}`,
        unscheduled: true,
        drilldownPath: `/app/purchasing/purchase-orders/${po.id}`,
        metadata: { purchaseOrderId: po.id, openQty, unscheduled: true },
      });
      continue;
    }

    const expectedReceiptDate = po.expected_date.slice(0, 10);
    const timing = resolveApPaymentDate({
      issueDate: expectedReceiptDate,
      dueDate: null,
      partyId: po.party_id,
      defaultApDays: input.defaultApDays,
      partyOverrides: input.partyOverrides,
    });

    events.push({
      organizationId,
      sourceType: "po_line_commitment",
      sourceId: line.id as string,
      sourceLabel: `PO #${po.number}`,
      expectedDate: timing.date,
      amount: openAmount,
      flowKind: "outflow",
      category: "purchasing",
      dedupeKey: `po:line:${line.id as string}`,
      sourceQuality: "planned",
      explanation: `Purchasing — open PO commitment — PO #${po.number}`,
      drilldownPath: `/app/purchasing/purchase-orders/${po.id}`,
      metadata: { purchaseOrderId: po.id, openQty, expectedReceiptDate },
    });
  }

  return { events, unscheduledCount };
}

export async function projectPurchasingCash(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    asOfDate: string;
    horizonWeeks: CashHorizonWeek[];
    horizonStart: string;
    horizonEnd: string;
    defaultApDays: number;
    partyOverrides: PartyTimingOverrides;
    openPayables: OpenPayable[];
  },
): Promise<{ lines: CashFlowLine[]; unscheduledCount: number }> {
  const loaded = await loadPurchasingCashEvents(supabase, organizationId, input);
  return {
    lines: projectCashEvents(loaded.events, input),
    unscheduledCount: loaded.unscheduledCount,
  };
}
