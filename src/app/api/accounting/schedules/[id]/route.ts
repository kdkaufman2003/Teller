import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import { updateAccountingSchedule } from "@/lib/accounting/schedules/schedule-crud";
import { listScheduleNotes } from "@/lib/accounting/schedules/schedule-service";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await context.params;

  const { data: schedule, error } = await ctx.supabase
    .from("teller_accounting_schedules")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("id", id)
    .maybeSingle();

  if (error) return jsonError(error.message, 500);
  if (!schedule) return jsonError("Schedule not found", 404);

  const { data: occurrences } = await ctx.supabase
    .from("teller_schedule_occurrences")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("schedule_id", id)
    .order("occurrence_date", { ascending: true });

  const notes = await listScheduleNotes(ctx.supabase, ctx.organizationId, "accounting_schedule", id);

  return Response.json({ schedule, occurrences: occurrences ?? [], notes });
}

export async function PATCH(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await context.params;
  const body = await request.json();

  try {
    const schedule = await updateAccountingSchedule(ctx.supabase, {
      organizationId: ctx.organizationId,
      scheduleId: id,
      patch: body,
      actorId: ctx.session.userId,
    });
    return Response.json({ schedule });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not update schedule", 400);
  }
}
