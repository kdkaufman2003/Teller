import { NextResponse } from "next/server";
import {
  activateNewAcquisition,
  activateOpeningBalanceAsset,
  capitalizeExpensedPurchase,
  linkFixedAssetAcquisition,
} from "@/lib/accounting/fixed-asset-acquisition";
import { jsonError, requireWriteBooks } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await params;
  const body = (await request.json()) as {
    action?: string;
    paymentKind?: "cash" | "ap";
    entryDate?: string;
    vendorPartyId?: string;
    openingAccumulatedDepreciation?: number;
    acquisitionJournalEntryId?: string;
    purchaseDocumentLineId?: string;
    expenseAccountId?: string;
    amount?: number;
    sourceDocumentLineId?: string;
  };

  const action = String(body.action ?? "activate");
  try {
    if (action === "link") {
      if (!body.acquisitionJournalEntryId) {
        return jsonError("acquisitionJournalEntryId is required");
      }
      const asset = await linkFixedAssetAcquisition(ctx.supabase, {
        organizationId: ctx.organizationId,
        assetId: id,
        acquisitionJournalEntryId: body.acquisitionJournalEntryId,
        purchaseDocumentLineId: body.purchaseDocumentLineId,
        actorId: ctx.session.userId,
      });
      return NextResponse.json({ asset });
    }

    if (action === "new_acquisition") {
      if (!body.entryDate) return jsonError("entryDate is required");
      const asset = await activateNewAcquisition(ctx.supabase, {
        organizationId: ctx.organizationId,
        assetId: id,
        paymentKind: body.paymentKind ?? "cash",
        entryDate: body.entryDate,
        vendorPartyId: body.vendorPartyId,
        actorId: ctx.session.userId,
      });
      return NextResponse.json({ asset });
    }

    if (action === "opening_balance") {
      if (!body.entryDate) return jsonError("entryDate is required");
      const asset = await activateOpeningBalanceAsset(ctx.supabase, {
        organizationId: ctx.organizationId,
        assetId: id,
        entryDate: body.entryDate,
        openingAccumulatedDepreciation: body.openingAccumulatedDepreciation,
        actorId: ctx.session.userId,
      });
      return NextResponse.json({ asset });
    }

    if (action === "capitalize") {
      if (!body.entryDate || !body.expenseAccountId || body.amount == null) {
        return jsonError("entryDate, expenseAccountId, and amount are required");
      }
      const asset = await capitalizeExpensedPurchase(ctx.supabase, {
        organizationId: ctx.organizationId,
        assetId: id,
        expenseAccountId: body.expenseAccountId,
        amount: body.amount,
        entryDate: body.entryDate,
        sourceDocumentLineId: body.sourceDocumentLineId,
        actorId: ctx.session.userId,
      });
      return NextResponse.json({ asset });
    }

    return jsonError("Unknown action", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Activation failed", 400);
  }
}
