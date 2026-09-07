import { NextResponse } from "next/server";
import { createAdjustingJournal, postAdjustingJournal } from "@/lib/accounting/adjusting-journals";
import { canPostAdjustments } from "@/lib/accounting/cpa";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data, error } = await supabase
    .from("teller_adjusting_journal_entries")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ adjustments: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  if (!canPostAdjustments(ctx.session.profile?.role)) return jsonError("Forbidden", 403);
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    entryDate?: string;
    memo?: string;
    reference?: string;
    adjustmentType?: string;
    lines?: Array<{
      accountId: string;
      debit?: number;
      credit?: number;
      memo?: string;
      jobId?: string | null;
      fixedAssetId?: string | null;
    }>;
    post?: boolean;
  };

  if (!body.entryDate || !body.memo || !body.lines?.length) {
    return jsonError("entryDate, memo, and lines are required", 400);
  }

  try {
    const adjustment = await createAdjustingJournal(supabase, {
      organizationId,
      entryDate: body.entryDate,
      memo: body.memo,
      reference: body.reference,
      adjustmentType: body.adjustmentType,
      lines: body.lines,
      actorId: session.userId,
    });

    if (body.post) {
      const posted = await postAdjustingJournal(supabase, {
        organizationId,
        adjustmentId: adjustment.id as string,
        actorId: session.userId,
        approvalRequired: false,
      });
      return NextResponse.json(posted, { status: 201 });
    }

    return NextResponse.json({ adjustment }, { status: 201 });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not create adjustment", 400);
  }
}
