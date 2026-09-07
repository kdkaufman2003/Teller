import { NextResponse } from "next/server";
import {
  deleteDraftFixedAsset,
  loadFixedAsset,
  updateFixedAssetMetadata,
} from "@/lib/accounting/fixed-assets";
import { buildAssetDepreciationSchedule } from "@/lib/accounting/fixed-asset-depreciation";
import { sumPostedDepreciationForAsset } from "@/lib/accounting/fixed-assets";
import { netBookValue } from "@/lib/accounting/fixed-asset-depreciation-calc";
import { asNumber } from "@/lib/format";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await params;

  const asset = await loadFixedAsset(ctx.supabase, ctx.organizationId, id);
  const schedule = await buildAssetDepreciationSchedule(ctx.supabase, ctx.organizationId, id);
  const accum = await sumPostedDepreciationForAsset(ctx.supabase, id);

  return NextResponse.json({
    asset,
    schedule,
    accumulatedDepreciation: accum,
    netBookValue: netBookValue(asNumber(asset.original_cost), accum),
  });
}

export async function PATCH(request: Request, { params }: Params) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await params;
  const body = (await request.json()) as Record<string, unknown>;

  const asset = await updateFixedAssetMetadata(ctx.supabase, {
    organizationId: ctx.organizationId,
    assetId: id,
    patch: body,
    actorId: ctx.session.userId,
  });

  return NextResponse.json({ asset });
}

export async function DELETE(_request: Request, { params }: Params) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await params;

  await deleteDraftFixedAsset(ctx.supabase, ctx.organizationId, id);
  return NextResponse.json({ ok: true });
}
