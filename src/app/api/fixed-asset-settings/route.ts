import { NextResponse } from "next/server";
import {
  loadFixedAssetSettings,
  updateFixedAssetSettings,
} from "@/lib/accounting/fixed-asset-settings";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const settings = await loadFixedAssetSettings(ctx.supabase, ctx.organizationId);
  return NextResponse.json({ settings });
}

export async function PATCH(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const body = (await request.json()) as {
    capitalization_threshold?: number | null;
    depreciation_convention?: string;
    rounding_policy?: string;
  };

  const settings = await updateFixedAssetSettings(ctx.supabase, {
    organizationId: ctx.organizationId,
    patch: body,
    actorId: ctx.session.userId,
  });

  return NextResponse.json({ settings });
}
