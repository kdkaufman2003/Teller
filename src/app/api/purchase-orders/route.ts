import { NextResponse } from "next/server";
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  loadPurchaseOrderDetail,
  markPurchaseOrderSent,
  receivePurchaseOrder,
  rejectPurchaseOrder,
  submitPurchaseOrderForApproval,
  updatePurchaseOrderDraft,
} from "@/lib/accounting/purchase-orders";
import { convertPurchaseOrderToBill } from "@/lib/accounting/po-to-bill";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data, error } = await supabase
    .from("teller_purchase_orders")
    .select("id, number, status, issue_date, expected_date, total, party_id, job_id")
    .eq("organization_id", organizationId)
    .order("issue_date", { ascending: false });

  if (error) return jsonError(error.message, 500);

  const partyIds = [...new Set((data ?? []).map((row) => row.party_id).filter(Boolean))];
  const { data: parties } = partyIds.length
    ? await supabase.from("teller_parties").select("id, name").in("id", partyIds)
    : { data: [] };
  const partyNames = new Map((parties ?? []).map((row) => [row.id, row.name]));

  return NextResponse.json({
    purchaseOrders: (data ?? []).map((row) => ({
      ...row,
      party_name: partyNames.get(row.party_id) || "",
    })),
  });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const body = (await request.json()) as {
    partyId?: string;
    jobId?: string;
    issueDate?: string;
    expectedDate?: string;
    shipTo?: string;
    buyerName?: string;
    vendorMessage?: string;
    memo?: string;
    lines?: Array<{
      description?: string;
      quantity?: number;
      unitCost?: number;
      accountId?: string;
      jobId?: string;
      costCategory?: string;
      costType?: string;
    }>;
  };

  if (!body.partyId) return jsonError("Vendor is required");
  if (!body.lines?.length) return jsonError("At least one line is required");

  try {
    const result = await createPurchaseOrder(ctx.supabase, {
      organizationId: ctx.organizationId,
      partyId: body.partyId,
      jobId: body.jobId,
      issueDate: body.issueDate || new Date().toISOString().slice(0, 10),
      expectedDate: body.expectedDate,
      shipTo: body.shipTo,
      buyerName: body.buyerName,
      vendorMessage: body.vendorMessage,
      memo: body.memo,
      lines: body.lines.map((line) => ({
        description: line.description || "Line item",
        quantity: line.quantity ?? 1,
        unitCost: line.unitCost ?? 0,
        accountId: line.accountId,
        jobId: line.jobId,
        costCategory: line.costCategory,
        costType: line.costType,
      })),
      actorId: ctx.session.userId,
    });
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not create PO", 400);
  }
}
