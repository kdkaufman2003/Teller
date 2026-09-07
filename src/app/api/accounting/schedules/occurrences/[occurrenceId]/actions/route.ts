import { jsonError, requireWriteBooks } from "@/lib/api";
import {
  approveScheduleOccurrence,
  postApprovedOccurrence,
  retryFailedOccurrence,
  reverseOccurrenceWithCanonicalFlow,
  skipScheduleOccurrence,
} from "@/lib/accounting/schedules/occurrence-workflow";

type RouteContext = { params: Promise<{ occurrenceId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { occurrenceId } = await context.params;
  const body = (await request.json()) as { action?: string; reason?: string; reversalDate?: string };

  if (!body.action) return jsonError("action is required", 400);

  try {
    switch (body.action) {
      case "approve":
        await approveScheduleOccurrence(ctx.supabase, {
          organizationId: ctx.organizationId,
          occurrenceId,
          actorId: ctx.session.userId,
        });
        return Response.json({ ok: true });
      case "post": {
        const result = await postApprovedOccurrence(ctx.supabase, {
          organizationId: ctx.organizationId,
          occurrenceId,
          actorId: ctx.session.userId,
        });
        return Response.json(result);
      }
      case "skip":
        await skipScheduleOccurrence(ctx.supabase, {
          organizationId: ctx.organizationId,
          occurrenceId,
          reason: body.reason ?? "",
          actorId: ctx.session.userId,
        });
        return Response.json({ ok: true });
      case "retry":
        await retryFailedOccurrence(ctx.supabase, {
          organizationId: ctx.organizationId,
          occurrenceId,
          actorId: ctx.session.userId,
        });
        return Response.json({ ok: true });
      case "reverse": {
        const result = await reverseOccurrenceWithCanonicalFlow(ctx.supabase, {
          organizationId: ctx.organizationId,
          occurrenceId,
          reversalDate: body.reversalDate ?? new Date().toISOString().slice(0, 10),
          actorId: ctx.session.userId,
        });
        return Response.json(result);
      }
      default:
        return jsonError("Unknown action", 400);
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Occurrence action failed", 400);
  }
}
