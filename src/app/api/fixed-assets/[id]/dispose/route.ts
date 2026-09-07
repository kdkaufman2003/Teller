import { NextResponse } from "next/server";
import {
  assertValidDisposalOperationId,
  disposeFixedAsset,
  undoFixedAssetDisposal,
} from "@/lib/accounting/fixed-asset-disposal";
import type { DisposalType } from "@/lib/accounting/fixed-asset-types";
import { jsonError, requireWriteBooks } from "@/lib/api";
import { canPostAdjustments } from "@/lib/accounting/cpa";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await params;
  const body = (await request.json()) as {
    action?: string;
    disposalDate?: string;
    disposalType?: DisposalType;
    proceeds?: number;
    cashAccountId?: string;
    reason?: string;
    reversalDate?: string;
    operationId?: string;
  };

  try {
    if (body.action === "undo") {
      if (!canPostAdjustments(ctx.session.profile?.role)) {
        return jsonError("You do not have permission to undo disposal", 403);
      }
      if (!body.reversalDate || !body.reason?.trim()) {
        return jsonError("reversalDate and reason are required");
      }
      const result = await undoFixedAssetDisposal(ctx.supabase, {
        organizationId: ctx.organizationId,
        assetId: id,
        reversalDate: body.reversalDate,
        reason: body.reason,
        actorId: ctx.session.userId,
      });
      return NextResponse.json(result);
    }

    if (!body.disposalDate || !body.disposalType) {
      return jsonError("disposalDate and disposalType are required");
    }

    try {
      assertValidDisposalOperationId(body.operationId);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "operationId is required", 400);
    }

    const result = await disposeFixedAsset(ctx.supabase, {
      organizationId: ctx.organizationId,
      assetId: id,
      disposalDate: body.disposalDate,
      disposalType: body.disposalType,
      proceeds: body.proceeds,
      cashAccountId: body.cashAccountId,
      reason: body.reason,
      operationId: body.operationId.trim(),
      actorId: ctx.session.userId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Disposal failed", 400);
  }
}
