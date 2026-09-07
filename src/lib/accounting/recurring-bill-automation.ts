import type { SupabaseClient } from "@supabase/supabase-js";
import { generateRecurringBillDraft } from "./recurring-bills";
import { recordAuditEvent } from "./audit";
import { recurringBillIdempotencyKey } from "./schedules/types";

export async function pauseRecurringBillTemplate(
  supabase: SupabaseClient,
  input: { organizationId: string; templateId: string; actorId?: string | null },
) {
  await supabase
    .from("teller_recurring_bill_templates")
    .update({ template_status: "paused", updated_at: new Date().toISOString() })
    .eq("organization_id", input.organizationId)
    .eq("id", input.templateId);
  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "bill.created",
    resourceKind: "recurring_bill_template",
    resourceId: input.templateId,
    metadata: { action: "paused" },
  });
}

export async function resumeRecurringBillTemplate(
  supabase: SupabaseClient,
  input: { organizationId: string; templateId: string; actorId?: string | null },
) {
  await supabase
    .from("teller_recurring_bill_templates")
    .update({ template_status: "active", updated_at: new Date().toISOString() })
    .eq("organization_id", input.organizationId)
    .eq("id", input.templateId);
}

export async function terminateRecurringBillTemplate(
  supabase: SupabaseClient,
  input: { organizationId: string; templateId: string; actorId?: string | null },
) {
  await supabase
    .from("teller_recurring_bill_templates")
    .update({
      template_status: "terminated",
      active: false,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.templateId);
}

export async function generateRecurringBillWithRun(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    templateId: string;
    occurrenceDate: string;
    actorId?: string | null;
  },
) {
  const idempotencyKey = recurringBillIdempotencyKey(input.templateId, input.occurrenceDate);

  const { data: existingRun } = await supabase
    .from("teller_recurring_bill_runs")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existingRun?.document_id) {
    return { billId: existingRun.document_id as string, duplicate: true, run: existingRun };
  }

  const draft = await generateRecurringBillDraft(supabase, input);

  const { data: run, error } = await supabase
    .from("teller_recurring_bill_runs")
    .insert({
      organization_id: input.organizationId,
      template_id: input.templateId,
      occurrence_date: input.occurrenceDate.slice(0, 10),
      document_id: draft.billId,
      status: "generated",
      idempotency_key: idempotencyKey,
    })
    .select("*")
    .single();

  if (error?.code === "23505") {
    const { data: raced } = await supabase
      .from("teller_recurring_bill_runs")
      .select("*")
      .eq("organization_id", input.organizationId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    return { billId: raced?.document_id as string, duplicate: true, run: raced };
  }
  if (error) throw new Error(error.message);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "recurring_bill.generated",
    resourceKind: "recurring_bill_run",
    resourceId: run!.id as string,
    metadata: { billId: draft.billId, templateId: input.templateId },
  });

  return { ...draft, run };
}

/** Recurring bills never auto-pay — draft/approval only. */
export function recurringBillAutoPayDisabled(): true {
  return true;
}
