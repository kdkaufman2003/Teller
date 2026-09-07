import { NextResponse } from "next/server";
import { createDraftFixedAsset } from "@/lib/accounting/fixed-assets";
import { buildFixedAssetRegister } from "@/lib/accounting/fixed-asset-register";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const register = await buildFixedAssetRegister(ctx.supabase, ctx.organizationId);
  return NextResponse.json({ assets: register });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const body = (await request.json()) as {
    name?: string;
    categoryId?: string;
    acquisitionMode?: "linked" | "new_acquisition" | "opening_balance";
    originalCost?: number;
    salvageValue?: number;
    usefulLifeMonths?: number;
    placedInServiceDate?: string;
    acquisitionDate?: string;
    description?: string;
  };

  const name = String(body.name ?? "").trim();
  if (!name) return jsonError("name is required");

  const asset = await createDraftFixedAsset(ctx.supabase, {
    organizationId: ctx.organizationId,
    name,
    categoryId: body.categoryId,
    acquisitionMode: body.acquisitionMode,
    originalCost: body.originalCost,
    salvageValue: body.salvageValue,
    usefulLifeMonths: body.usefulLifeMonths,
    placedInServiceDate: body.placedInServiceDate,
    acquisitionDate: body.acquisitionDate,
    description: body.description,
    actorId: ctx.session.userId,
  });

  return NextResponse.json({ asset });
}
