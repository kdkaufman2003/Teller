import { NextResponse } from "next/server";
import {
  postDepreciationBatch,
  previewDepreciationForPeriod,
  repostDepreciationAfterReversal,
  reverseDepreciationEntry,
} from "@/lib/accounting/fixed-asset-depreciation";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const periodYear = Number(url.searchParams.get("periodYear"));
  const periodMonth = Number(url.searchParams.get("periodMonth"));
  if (!periodYear || !periodMonth) return jsonError("periodYear and periodMonth are required");

  const preview = await previewDepreciationForPeriod(
    ctx.supabase,
    ctx.organizationId,
    periodYear,
    periodMonth,
  );
  return NextResponse.json(preview);
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const body = (await request.json()) as {
    action?: string;
    periodYear?: number;
    periodMonth?: number;
    entryDate?: string;
    depreciationEntryId?: string;
    reversedEntryId?: string;
    reversalDate?: string;
  };

  try {
    if (body.action === "reverse") {
      if (!body.depreciationEntryId || !body.reversalDate) {
        return jsonError("depreciationEntryId and reversalDate are required");
      }
      const result = await reverseDepreciationEntry(ctx.supabase, {
        organizationId: ctx.organizationId,
        depreciationEntryId: body.depreciationEntryId,
        reversalDate: body.reversalDate,
        actorId: ctx.session.userId,
      });
      return NextResponse.json(result);
    }

    if (body.action === "repost") {
      if (!body.reversedEntryId || !body.entryDate) {
        return jsonError("reversedEntryId and entryDate are required");
      }
      const result = await repostDepreciationAfterReversal(ctx.supabase, {
        organizationId: ctx.organizationId,
        reversedEntryId: body.reversedEntryId,
        entryDate: body.entryDate,
        actorId: ctx.session.userId,
      });
      return NextResponse.json(result);
    }

    if (!body.periodYear || !body.periodMonth || !body.entryDate) {
      return jsonError("periodYear, periodMonth, and entryDate are required");
    }

    const result = await postDepreciationBatch(ctx.supabase, {
      organizationId: ctx.organizationId,
      periodYear: body.periodYear,
      periodMonth: body.periodMonth,
      entryDate: body.entryDate,
      actorId: ctx.session.userId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Depreciation post failed", 400);
  }
}
