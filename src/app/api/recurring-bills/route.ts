import { NextResponse } from "next/server";
import { generateRecurringBillDraft } from "@/lib/accounting/recurring-bills";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { data, error } = await ctx.supabase
    .from("teller_recurring_bill_templates")
    .select("id, name, party_id, active, recurrence, start_date, last_generated_at")
    .eq("organization_id", ctx.organizationId)
    .order("name");

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ templates: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const body = (await request.json()) as {
    name?: string;
    partyId?: string;
    jobId?: string;
    recurrence?: string;
    startDate?: string;
    endDate?: string;
    terms?: string;
    defaultDueDays?: number;
    memo?: string;
    tax?: number;
    lines?: Array<{
      description?: string;
      quantity?: number;
      unitPrice?: number;
      accountId?: string;
      jobId?: string;
      costCategory?: string;
      costType?: string;
    }>;
    action?: "generate";
    templateId?: string;
    occurrenceDate?: string;
  };

  if (body.action === "generate") {
    if (!body.templateId || !body.occurrenceDate) {
      return jsonError("templateId and occurrenceDate are required");
    }
    try {
      const result = await generateRecurringBillDraft(ctx.supabase, {
        organizationId: ctx.organizationId,
        templateId: body.templateId,
        occurrenceDate: body.occurrenceDate,
        actorId: ctx.session.userId,
      });
      return NextResponse.json(result);
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Generation failed", 400);
    }
  }

  if (!body.name?.trim() || !body.partyId) {
    return jsonError("Name and vendor are required");
  }

  const lines = body.lines ?? [];
  const subtotal = lines.reduce(
    (sum, line) => sum + (line.quantity ?? 1) * (line.unitPrice ?? 0),
    0,
  );

  const { data: template, error } = await ctx.supabase
    .from("teller_recurring_bill_templates")
    .insert({
      organization_id: ctx.organizationId,
      name: body.name.trim(),
      party_id: body.partyId,
      job_id: body.jobId || null,
      recurrence: body.recurrence || "monthly",
      start_date: body.startDate || new Date().toISOString().slice(0, 10),
      end_date: body.endDate || null,
      terms: body.terms || "",
      default_due_days: body.defaultDueDays ?? 30,
      memo: body.memo || "",
      tax: body.tax ?? 0,
      created_by: ctx.session.userId,
    })
    .select("id")
    .single();

  if (error || !template) return jsonError(error?.message || "Could not create template", 500);

  if (lines.length) {
    await ctx.supabase.from("teller_recurring_bill_template_lines").insert(
      lines.map((line, index) => ({
        template_id: template.id,
        description: line.description || "Line",
        quantity: line.quantity ?? 1,
        unit_price: line.unitPrice ?? 0,
        amount: (line.quantity ?? 1) * (line.unitPrice ?? 0),
        account_id: line.accountId || null,
        job_id: line.jobId || null,
        cost_category: line.costCategory || "",
        cost_type: line.costType || "",
        sort_order: index,
      })),
    );
  }

  return NextResponse.json({ id: template.id });
}
