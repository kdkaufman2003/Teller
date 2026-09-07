import { NextResponse } from "next/server";
import { previewAccrualSettlement } from "@/lib/accounting/accrual-settlement/settlement-service";
import { asNumber } from "@/lib/format";
import { jsonError, requireBooks } from "@/lib/api";

export async function POST(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const body = (await request.json()) as {
    partyId?: string;
    issueDate?: string;
    tax?: number;
    lines?: Array<{ amount?: number; accountId?: string; description?: string }>;
    allocations?: Array<{ occurrenceId: string; appliedAmount: number }>;
  };

  if (!body.allocations?.length) return jsonError("Select at least one accrual occurrence");

  try {
    const preview = await previewAccrualSettlement(supabase, {
      organizationId,
      partyId: body.partyId ?? null,
      issueDate: body.issueDate ?? new Date().toISOString().slice(0, 10),
      tax: asNumber(body.tax),
      lines: (body.lines ?? []).map((line) => ({
        amount: asNumber(line.amount),
        account_id: line.accountId ?? null,
        description: line.description ?? "Bill line",
      })),
      allocations: body.allocations,
    });
    return NextResponse.json({ preview });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Preview failed", 400);
  }
}
