import { jsonError, requireWriteBooks } from "@/lib/api";
import {
  activateAccountingSchedule,
  transitionScheduleLifecycle,
} from "@/lib/accounting/schedules/schedule-crud";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await context.params;
  const body = (await request.json()) as { action?: string };

  if (!body.action) return jsonError("action is required", 400);

  try {
    if (body.action === "activate") {
      const result = await activateAccountingSchedule(ctx.supabase, {
        organizationId: ctx.organizationId,
        scheduleId: id,
        actorId: ctx.session.userId,
      });
      return Response.json(result);
    }

    if (body.action === "pause" || body.action === "resume" || body.action === "cancel") {
      const result = await transitionScheduleLifecycle(ctx.supabase, {
        organizationId: ctx.organizationId,
        scheduleId: id,
        action: body.action,
        actorId: ctx.session.userId,
      });
      return Response.json(result);
    }

    return jsonError("Unknown action", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Lifecycle action failed", 400);
  }
}
