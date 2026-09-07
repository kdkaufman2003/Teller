import { NextResponse } from "next/server";
import {
  createRecurringJournalTemplate,
  generateRecurringJournalDraft,
} from "@/lib/accounting/recurring-journals";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data, error } = await supabase
    .from("teller_recurring_journal_templates")
    .select("*")
    .eq("organization_id", organizationId)
    .order("name");

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ templates: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    name?: string;
    memo?: string;
    frequency?: "monthly" | "quarterly" | "annually";
    startDate?: string;
    endDate?: string | null;
    lines?: Array<{ accountId: string; debit?: number; credit?: number; memo?: string }>;
    adjustmentType?: string;
    generateForDate?: string;
    templateId?: string;
  };

  if (body.templateId && body.generateForDate) {
    try {
      const result = await generateRecurringJournalDraft(supabase, {
        organizationId,
        templateId: body.templateId,
        targetDate: body.generateForDate,
        actorId: session.userId,
      });
      return NextResponse.json(result);
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Generate failed", 400);
    }
  }

  if (!body.name || !body.frequency || !body.startDate || !body.lines?.length) {
    return jsonError("name, frequency, startDate, and lines are required", 400);
  }

  try {
    const template = await createRecurringJournalTemplate(supabase, {
      organizationId,
      name: body.name,
      memo: body.memo,
      frequency: body.frequency,
      startDate: body.startDate,
      endDate: body.endDate,
      lines: body.lines,
      adjustmentType: body.adjustmentType,
      actorId: session.userId,
    });
    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not create template", 400);
  }
}
