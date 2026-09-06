import { NextResponse } from "next/server";
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  loadPurchaseOrderDetail,
  markPurchaseOrderSent,
  receivePurchaseOrder,
  rejectPurchaseOrder,
  submitPurchaseOrderForApproval,
  updatePurchaseOrderDraft,
} from "@/lib/accounting/purchase-orders";
import { convertPurchaseOrderToBill } from "@/lib/accounting/po-to-bill";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await params;

  try {
    const detail = await loadPurchaseOrderDetail(ctx.supabase, ctx.organizationId, id);
    return NextResponse.json(detail);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Not found", 404);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await params;
  const body = (await request.json()) as Record<string, unknown>;

  try {
    await updatePurchaseOrderDraft(ctx.supabase, {
      organizationId: ctx.organizationId,
      purchaseOrderId: id,
      partyId: body.partyId as string | undefined,
      jobId: body.jobId as string | null | undefined,
      issueDate: body.issueDate as string | undefined,
      expectedDate: body.expectedDate as string | null | undefined,
      shipTo: body.shipTo as string | undefined,
      buyerName: body.buyerName as string | undefined,
      vendorMessage: body.vendorMessage as string | undefined,
      memo: body.memo as string | undefined,
      lines: body.lines as Parameters<typeof updatePurchaseOrderDraft>[1]["lines"],
      actorId: ctx.session.userId,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Update failed", 400);
  }
}

export async function POST(request: Request, { params }: Params) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await params;
  const body = (await request.json()) as {
    action?: string;
    reason?: string;
    receiptDate?: string;
    referenceNumber?: string;
    location?: string;
    memo?: string;
    lines?: Array<{ purchaseOrderLineId: string; quantityReceived: number }>;
    billLines?: Array<{
      purchaseOrderLineId: string;
      quantityToBill: number;
      unitCostOverride?: number;
    }>;
    issueDate?: string;
    dueDate?: string;
    referenceNumberBill?: string;
    acknowledgePriceVariance?: boolean;
  };

  const base = {
    organizationId: ctx.organizationId,
    purchaseOrderId: id,
    actorId: ctx.session.userId,
  };

  try {
    switch (body.action) {
      case "submit":
        await submitPurchaseOrderForApproval(ctx.supabase, base);
        break;
      case "approve":
        await approvePurchaseOrder(ctx.supabase, base);
        break;
      case "reject":
        if (!body.reason?.trim()) return jsonError("Rejection reason is required");
        await rejectPurchaseOrder(ctx.supabase, { ...base, reason: body.reason });
        break;
      case "send":
        await markPurchaseOrderSent(ctx.supabase, base);
        break;
      case "cancel":
        await cancelPurchaseOrder(ctx.supabase, { ...base, reason: body.reason });
        break;
      case "close":
        await closePurchaseOrder(ctx.supabase, base);
        break;
      case "receive":
        if (!body.receiptDate || !body.lines?.length) {
          return jsonError("Receipt date and lines are required");
        }
        await receivePurchaseOrder(ctx.supabase, {
          ...base,
          receiptDate: body.receiptDate,
          referenceNumber: body.referenceNumber,
          location: body.location,
          memo: body.memo,
          lines: body.lines,
        });
        break;
      case "convert_to_bill":
        if (!body.issueDate || !body.billLines?.length) {
          return jsonError("Issue date and bill lines are required");
        }
        const result = await convertPurchaseOrderToBill(ctx.supabase, {
          organizationId: ctx.organizationId,
          purchaseOrderId: id,
          issueDate: body.issueDate,
          dueDate: body.dueDate,
          referenceNumber: body.referenceNumberBill,
          memo: body.memo,
          lines: body.billLines,
          actorId: ctx.session.userId,
          acknowledgePriceVariance: body.acknowledgePriceVariance,
        });
        return NextResponse.json(result);
      default:
        return jsonError("Unknown action", 400);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Action failed", 400);
  }
}
