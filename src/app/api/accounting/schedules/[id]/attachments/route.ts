import { jsonError, requireWriteBooks } from "@/lib/api";
import { addScheduleAttachmentMetadata } from "@/lib/accounting/schedules/schedule-service";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await context.params;
  const body = (await request.json()) as { fileName?: string; storagePath?: string; contentType?: string };
  if (!body.fileName?.trim() || !body.storagePath?.trim()) {
    return jsonError("fileName and storagePath are required", 400);
  }

  try {
    const attachment = await addScheduleAttachmentMetadata(ctx.supabase, {
      organizationId: ctx.organizationId,
      resourceKind: "accounting_schedule",
      resourceId: id,
      fileName: body.fileName,
      storagePath: body.storagePath,
      contentType: body.contentType,
      actorId: ctx.session.userId,
    });
    return Response.json({ attachment });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not save attachment", 400);
  }
}
