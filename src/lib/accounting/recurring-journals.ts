import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent } from "./audit";
import { createAdjustingJournal, type AdjustmentLine } from "./adjusting-journals";
import { endOfMonth } from "./periods";
import { resolveLegalEntityId } from "./post";

export type RecurringFrequency = "monthly" | "quarterly" | "annually";

export async function createRecurringJournalTemplate(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    name: string;
    memo?: string;
    frequency: RecurringFrequency;
    startDate: string;
    endDate?: string | null;
    lines: AdjustmentLine[];
    adjustmentType?: string;
    actorId?: string | null;
  },
) {
  const legalEntityId = await resolveLegalEntityId(supabase, input.organizationId);

  const { data, error } = await supabase
    .from("teller_recurring_journal_templates")
    .insert({
      organization_id: input.organizationId,
      legal_entity_id: legalEntityId,
      name: input.name,
      memo: input.memo ?? input.name,
      frequency: input.frequency,
      start_date: input.startDate.slice(0, 10),
      end_date: input.endDate?.slice(0, 10) ?? null,
      next_run_date: input.startDate.slice(0, 10),
      lines: input.lines,
      adjustment_type: input.adjustmentType ?? "general",
      active: true,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not create template");

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "recurring_journal.created",
    resourceKind: "recurring_journal_template",
    resourceId: data.id as string,
  });

  return data;
}

function periodForDate(date: string): { year: number; month: number; end: string } {
  const d = new Date(date.slice(0, 10) + "T12:00:00");
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  return { year, month, end: endOfMonth(year, month) };
}

export async function generateRecurringJournalDraft(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    templateId: string;
    targetDate: string;
    actorId?: string | null;
  },
) {
  const { data: template, error } = await supabase
    .from("teller_recurring_journal_templates")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.templateId)
    .single();
  if (error || !template) throw new Error(error?.message || "Template not found");
  if (!template.active) throw new Error("Template is inactive");

  const target = input.targetDate.slice(0, 10);
  const { year, month, end } = periodForDate(target);

  const { data: existing } = await supabase
    .from("teller_recurring_journal_runs")
    .select("*, teller_adjusting_journal_entries(*)")
    .eq("template_id", input.templateId)
    .eq("period_year", year)
    .eq("period_month", month)
    .maybeSingle();

  if (existing?.adjusting_journal_entry_id) {
    return { run: existing, adjustment: existing.teller_adjusting_journal_entries, duplicate: true };
  }

  const adjustment = await createAdjustingJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: end,
    memo: `${template.name} (${year}-${String(month).padStart(2, "0")})`,
    reference: `recurring:${template.id}`,
    adjustmentType: template.adjustment_type as string,
    lines: template.lines as AdjustmentLine[],
    actorId: input.actorId,
  });

  const { data: run, error: runError } = await supabase
    .from("teller_recurring_journal_runs")
    .insert({
      organization_id: input.organizationId,
      template_id: input.templateId,
      period_year: year,
      period_month: month,
      target_period_end: end,
      adjusting_journal_entry_id: adjustment.id,
      status: "generated",
    })
    .select("*")
    .single();
  if (runError || !run) throw new Error(runError?.message || "Could not record run");

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "recurring_journal.generated",
    resourceKind: "recurring_journal_run",
    resourceId: run.id as string,
    metadata: { templateId: input.templateId, adjustmentId: adjustment.id },
  });

  return { run, adjustment, duplicate: false };
}

export async function postRecurringJournalRun(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    runId: string;
    actorId?: string | null;
    accountingVersion?: number;
  },
) {
  const { data: run, error } = await supabase
    .from("teller_recurring_journal_runs")
    .select("*, teller_recurring_journal_templates(*), teller_adjusting_journal_entries(*)")
    .eq("organization_id", input.organizationId)
    .eq("id", input.runId)
    .single();
  if (error || !run) throw new Error(error?.message || "Run not found");
  if (run.status === "posted") return { adjustment: run.teller_adjusting_journal_entries, duplicate: true };

  const template = run.teller_recurring_journal_templates as Record<string, unknown>;
  if (!template.auto_post_enabled || template.post_mode !== "auto_post") {
    throw new Error("Template is not configured for auto-post");
  }

  const adjustment = run.teller_adjusting_journal_entries as Record<string, unknown>;
  if (!adjustment) throw new Error("Missing adjustment for run");

  const { postAdjustingJournal } = await import("./adjusting-journals");
  const posted = await postAdjustingJournal(supabase, {
    organizationId: input.organizationId,
    adjustmentId: adjustment.id as string,
    actorId: input.actorId,
  });

  await supabase
    .from("teller_recurring_journal_runs")
    .update({ status: "posted" })
    .eq("id", run.id);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "recurring_journal.auto_posted",
    resourceKind: "recurring_journal_run",
    resourceId: run.id as string,
    metadata: { templateId: template.id, accountingVersion: input.accountingVersion },
  });

  return { adjustment: posted, duplicate: false };
}

export async function generateAndMaybeAutoPostRecurringJournal(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    templateId: string;
    targetDate: string;
    actorId?: string | null;
    orgAutoPostEnabled?: boolean;
    accountingVersion?: number;
  },
) {
  const draft = await generateRecurringJournalDraft(supabase, input);
  const { data: template } = await supabase
    .from("teller_recurring_journal_templates")
    .select("post_mode, auto_post_enabled")
    .eq("id", input.templateId)
    .single();

  if (
    input.orgAutoPostEnabled &&
    template?.auto_post_enabled &&
    template.post_mode === "auto_post" &&
    !draft.duplicate
  ) {
    await postRecurringJournalRun(supabase, {
      organizationId: input.organizationId,
      runId: draft.run.id as string,
      actorId: input.actorId,
      accountingVersion: input.accountingVersion,
    });
  }

  return draft;
}
