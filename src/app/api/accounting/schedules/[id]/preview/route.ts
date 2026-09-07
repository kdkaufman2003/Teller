import { jsonError, requireBooks } from "@/lib/api";
import { buildSchedulePreview } from "@/lib/accounting/schedules/preview";
import type { RecognitionMethod, ScheduleType } from "@/lib/accounting/schedules/types";

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

  const preview = buildSchedulePreview({
    scheduleType: schedule.schedule_type as ScheduleType,
    startDate: schedule.start_date as string,
    endDate: schedule.end_date as string | null,
    originalAmount: Number(schedule.original_amount),
    recognitionMethod: schedule.recognition_method as RecognitionMethod,
  });

  return Response.json({ preview });
}

export async function POST(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const body = await request.json();

  try {
    const preview = buildSchedulePreview({
      scheduleType: body.scheduleType,
      startDate: body.startDate,
      endDate: body.endDate,
      originalAmount: Number(body.originalAmount),
      recognitionMethod: body.recognitionMethod,
    });
    return Response.json({ preview });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not build preview", 400);
  }
}
