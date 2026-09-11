import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { generateTaxFilingPeriods, listTaxFilingPeriods } from "@/lib/accounting/tax/filing";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const url = new URL(request.url);
  const registrationId = url.searchParams.get("registrationId") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;

  try {
    const periods = await listTaxFilingPeriods(supabase, organizationId, {
      registrationId,
      status: status as never,
    });
    return NextResponse.json({ periods });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load filing periods", 400);
  }
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const body = (await request.json()) as {
    registrationId?: string;
    rangeStart?: string;
    rangeEnd?: string;
  };

  if (!body.registrationId?.trim()) return jsonError("registrationId is required", 400);
  if (!body.rangeStart?.trim() || !body.rangeEnd?.trim()) {
    return jsonError("rangeStart and rangeEnd are required", 400);
  }

  try {
    const periods = await generateTaxFilingPeriods(supabase, {
      organizationId,
      registrationId: body.registrationId.trim(),
      rangeStart: body.rangeStart.trim(),
      rangeEnd: body.rangeEnd.trim(),
    });
    return NextResponse.json({ periods });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not generate filing periods", 400);
  }
}
