import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanningAuditEventKind } from "./types";

export async function recordPlanningAuditEvent(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    actorId?: string | null;
    eventKind: PlanningAuditEventKind;
    entityKind: string;
    entityId: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const payload = sanitizeAuditPayload(input.payload ?? {});
  const { error } = await supabase.from("teller_planning_audit_events").insert({
    organization_id: input.organizationId,
    actor_id: input.actorId ?? null,
    event_kind: input.eventKind,
    entity_kind: input.entityKind,
    entity_id: input.entityId,
    payload,
  });
  if (error && !/does not exist|schema cache/i.test(error.message)) {
    throw new Error(error.message);
  }
}

function sanitizeAuditPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value == null) continue;
    if (typeof value === "string" && value.length > 500) {
      safe[key] = value.slice(0, 500);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
      continue;
    }
    if (typeof value === "string") {
      safe[key] = value;
    }
  }
  return safe;
}
