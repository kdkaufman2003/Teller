import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import {
  createCashManualOverride,
  deleteCashManualOverride,
  listCashManualOverrides,
} from "@/lib/planning/cash/cash-crud";
import type { CashFlowKind } from "@/lib/planning/cash/types";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  try {
    const overrides = await listCashManualOverrides(ctx.supabase, ctx.organizationId);
    return NextResponse.json({ overrides });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load adjustments", 400);
  }
}

export async function POST(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const body = (await request.json()) as {
    effectiveDate?: string;
    flowKind?: CashFlowKind;
    amount?: number;
    label?: string;
    notes?: string;
    planningCategory?: "general" | "capex";
  };

  if (!body.effectiveDate || !body.flowKind || body.amount == null || !body.label) {
    return jsonError("effectiveDate, flowKind, amount, and label are required", 400);
  }

  try {
    const row = await createCashManualOverride(ctx.supabase, {
      organizationId: ctx.organizationId,
      actorId: ctx.session.userId,
      override: {
        effectiveDate: body.effectiveDate,
        flowKind: body.flowKind,
        amount: Number(body.amount),
        label: body.label,
        notes: body.notes,
        planningCategory: body.planningCategory ?? "general",
      },
    });
    return NextResponse.json({ override: row });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not save adjustment", 400);
  }
}

export async function DELETE(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const overrideId = url.searchParams.get("id");
  if (!overrideId) return jsonError("id is required", 400);

  try {
    await deleteCashManualOverride(ctx.supabase, {
      organizationId: ctx.organizationId,
      overrideId,
      actorId: ctx.session.userId,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not delete adjustment", 400);
  }
}
