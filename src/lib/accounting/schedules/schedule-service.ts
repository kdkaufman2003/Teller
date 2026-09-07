import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent } from "../audit";

export type ScheduleResourceKind =
  | "accounting_schedule"
  | "schedule_occurrence"
  | "adjusting_journal"
  | "recurring_journal_template"
  | "close_checklist_item";

export async function addScheduleNote(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    resourceKind: ScheduleResourceKind;
    resourceId: string;
    noteText: string;
    actorId?: string | null;
  },
) {
  const { data, error } = await supabase
    .from("teller_schedule_notes")
    .insert({
      organization_id: input.organizationId,
      resource_kind: input.resourceKind,
      resource_id: input.resourceId,
      note_text: input.noteText.trim(),
      created_by: input.actorId ?? null,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not save note");
  return data;
}

export async function addScheduleAttachmentMetadata(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    resourceKind: ScheduleResourceKind;
    resourceId: string;
    fileName: string;
    storagePath: string;
    contentType?: string;
    actorId?: string | null;
  },
) {
  const { data, error } = await supabase
    .from("teller_schedule_attachments")
    .insert({
      organization_id: input.organizationId,
      resource_kind: input.resourceKind,
      resource_id: input.resourceId,
      file_name: input.fileName,
      storage_path: input.storagePath,
      content_type: input.contentType ?? "application/octet-stream",
      uploaded_by: input.actorId ?? null,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not save attachment");
  return data;
}

export async function listScheduleNotes(
  supabase: SupabaseClient,
  organizationId: string,
  resourceKind: ScheduleResourceKind,
  resourceId: string,
) {
  const { data, error } = await supabase
    .from("teller_schedule_notes")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("resource_kind", resourceKind)
    .eq("resource_id", resourceId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function pauseSchedule(
  supabase: SupabaseClient,
  input: { organizationId: string; scheduleId: string; actorId?: string | null },
) {
  await supabase
    .from("teller_accounting_schedules")
    .update({ status: "paused", updated_at: new Date().toISOString() })
    .eq("organization_id", input.organizationId)
    .eq("id", input.scheduleId);
  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "schedule.paused",
    resourceKind: "accounting_schedule",
    resourceId: input.scheduleId,
  });
}

export async function resumeSchedule(
  supabase: SupabaseClient,
  input: { organizationId: string; scheduleId: string; actorId?: string | null },
) {
  await supabase
    .from("teller_accounting_schedules")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("organization_id", input.organizationId)
    .eq("id", input.scheduleId);
  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "schedule.resumed",
    resourceKind: "accounting_schedule",
    resourceId: input.scheduleId,
  });
}

export async function cancelSchedule(
  supabase: SupabaseClient,
  input: { organizationId: string; scheduleId: string; actorId?: string | null },
) {
  await supabase
    .from("teller_accounting_schedules")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("organization_id", input.organizationId)
    .eq("id", input.scheduleId);
  await supabase
    .from("teller_schedule_occurrences")
    .update({ status: "skipped" })
    .eq("organization_id", input.organizationId)
    .eq("schedule_id", input.scheduleId)
    .in("status", ["scheduled", "generated"]);
  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "schedule.cancelled",
    resourceKind: "accounting_schedule",
    resourceId: input.scheduleId,
  });
}
