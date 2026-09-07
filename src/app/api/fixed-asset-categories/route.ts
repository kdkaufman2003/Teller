import { NextResponse } from "next/server";
import {
  createFixedAssetCategory,
  listFixedAssetCategories,
} from "@/lib/accounting/fixed-asset-settings";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const categories = await listFixedAssetCategories(ctx.supabase, ctx.organizationId);
  return NextResponse.json({ categories });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const body = (await request.json()) as {
    code?: string;
    name?: string;
    description?: string;
    defaultUsefulLifeMonths?: number;
    assetAccountId?: string;
    accumulatedDepreciationAccountId?: string;
    depreciationExpenseAccountId?: string;
    gainAccountId?: string;
    lossAccountId?: string;
  };

  if (!body.code?.trim() || !body.name?.trim()) return jsonError("code and name are required");

  const category = await createFixedAssetCategory(ctx.supabase, {
    organizationId: ctx.organizationId,
    code: body.code,
    name: body.name,
    description: body.description,
    defaultUsefulLifeMonths: body.defaultUsefulLifeMonths,
    assetAccountId: body.assetAccountId,
    accumulatedDepreciationAccountId: body.accumulatedDepreciationAccountId,
    depreciationExpenseAccountId: body.depreciationExpenseAccountId,
    gainAccountId: body.gainAccountId,
    lossAccountId: body.lossAccountId,
    actorId: ctx.session.userId,
  });

  return NextResponse.json({ category });
}
