import { jsonError, requireWriteBooks } from "@/lib/api";
import { addScheduleNote } from "@/lib/accounting/schedules/schedule-service";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await context.params;
  const body = (await request.json()) as { noteText?: string };
  if (!body.noteText?.trim()) return jsonError("noteText is required", 400);

  try {
    const note = await addScheduleNote(ctx.supabase, {
      organizationId: ctx.organizationId,
      resourceKind: "accounting_schedule",
      resourceId: id,
      noteText: body.noteText,
      actorId: ctx.session.userId,
    });
    return Response.json({ note });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not save note", 400);
  }
}
