import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber, todayISO } from "@/lib/format";
import { nextNumber } from "./accounts";
import { recordAuditEvent } from "./audit";

export async function generateRecurringBillDraft(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    templateId: string;
    occurrenceDate: string;
    actorId?: string | null;
  },
) {
  const { data: template, error } = await supabase
    .from("teller_recurring_bill_templates")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.templateId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!template || !template.active) throw new Error("Recurring template not found or inactive");

  const fingerprint = `${template.id}:${input.occurrenceDate}`;
  const { data: existing } = await supabase
    .from("teller_documents")
    .select("id, number")
    .eq("organization_id", input.organizationId)
    .eq("kind", "bill")
    .contains("metadata", { recurring_template_id: template.id, recurring_occurrence: input.occurrenceDate });
  if (existing?.length) {
    return { billId: existing[0].id as string, number: existing[0].number as string, duplicate: true };
  }

  const { data: lines } = await supabase
    .from("teller_recurring_bill_template_lines")
    .select("*")
    .eq("template_id", template.id)
    .order("sort_order");

  const subtotal = (lines ?? []).reduce((sum, line) => sum + asNumber(line.amount), 0);
  const tax = asNumber(template.tax);
  const total = subtotal + tax;

  const { data: existingNumbers } = await supabase
    .from("teller_documents")
    .select("number")
    .eq("organization_id", input.organizationId)
    .eq("kind", "bill");
  const number = nextNumber("BILL", (existingNumbers ?? []).map((row) => row.number as string));

  const dueDays = template.default_due_days ?? 30;
  const due = new Date(`${input.occurrenceDate}T00:00:00`);
  due.setDate(due.getDate() + dueDays);

  const { data: doc, error: docError } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: input.organizationId,
      kind: "bill",
      number,
      party_id: template.party_id,
      job_id: template.job_id,
      status: "draft",
      issue_date: input.occurrenceDate,
      due_date: due.toISOString().slice(0, 10),
      subtotal,
      tax,
      total,
      memo: template.memo || `Recurring: ${template.name}`,
      terms: template.terms || "",
      metadata: {
        recurring_template_id: template.id,
        recurring_occurrence: input.occurrenceDate,
        recurring_fingerprint: fingerprint,
      },
    })
    .select("id")
    .single();
  if (docError || !doc) throw new Error(docError?.message || "Could not generate draft bill");

  if (lines?.length) {
    await supabase.from("teller_document_lines").insert(
      lines.map((line, index) => ({
        document_id: doc.id,
        description: line.description,
        quantity: line.quantity,
        unit_price: line.unit_price,
        amount: line.amount,
        account_id: line.account_id,
        job_id: line.job_id,
        cost_category: line.cost_category,
        cost_type: line.cost_type,
        item_type: "expense",
        sort_order: line.sort_order ?? index,
      })),
    );
  }

  await supabase
    .from("teller_recurring_bill_templates")
    .update({ last_generated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", template.id);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "bill.created",
    resourceKind: "bill",
    resourceId: doc.id as string,
    metadata: { recurringTemplateId: template.id, occurrenceDate: input.occurrenceDate, number },
  });

  return { billId: doc.id as string, number, duplicate: false };
}

export function nextMonthlyOccurrence(from = todayISO()): string {
  const date = new Date(`${from}T00:00:00`);
  date.setMonth(date.getMonth() + 1);
  return date.toISOString().slice(0, 10);
}
