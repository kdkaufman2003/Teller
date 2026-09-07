import { NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { canPostAdjustments } from "@/lib/accounting/cpa";
import { assertEntryDateOpen, booksClosedThrough } from "@/lib/accounting/periods";
import { postJournal } from "@/lib/accounting/post";
import { jsonError, requireBooks } from "@/lib/api";

type AdjustmentLine = {
  account_id: string;
  debit?: number;
  credit?: number;
  memo?: string;
};

export async function POST(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  if (!canPostAdjustments(session.profile?.role)) {
    return jsonError("You do not have permission to post adjustments", 403);
  }

  const body = (await request.json()) as {
    entryDate?: string;
    memo?: string;
    lines?: AdjustmentLine[];
  };

  const entryDate = String(body.entryDate ?? "").slice(0, 10);
  const memo = String(body.memo ?? "").trim();
  const lines = body.lines ?? [];

  if (!entryDate) return jsonError("entryDate is required");
  if (!memo) return jsonError("memo is required");
  if (lines.length < 2) return jsonError("At least two lines are required");

  const { data: closes, error: closeError } = await supabase
    .from("teller_period_closes")
    .select("period_end, closed_at, effective_closed_through")
    .eq("organization_id", organizationId);

  if (closeError) return jsonError(closeError.message, 500);

  try {
    assertEntryDateOpen(booksClosedThrough(closes ?? []), entryDate);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Period is closed", 409);
  }

  try {
    const entryId = await postJournal(supabase, {
      organizationId,
      entryDate,
      memo,
      sourceKind: "adjustment",
      lines: lines.map((line) => ({
        account_id: line.account_id,
        debit: Number(line.debit) || 0,
        credit: Number(line.credit) || 0,
        memo: line.memo ?? "",
      })),
      actorId: session.userId,
      auditAction: "journal.posted",
    });

    await recordAuditEvent(supabase, {
      organizationId,
      actorId: session.userId,
      action: "journal.adjustment",
      resourceKind: "journal_entry",
      resourceId: entryId,
      metadata: { entryDate, memo, lineCount: lines.length },
    });

    return NextResponse.json({ entryId });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not post adjustment", 400);
  }
}
