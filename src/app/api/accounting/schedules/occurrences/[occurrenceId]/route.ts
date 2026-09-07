import { jsonError, requireBooks } from "@/lib/api";
import { loadOccurrenceDetail } from "@/lib/accounting/schedules/occurrence-workflow";

type RouteContext = { params: Promise<{ occurrenceId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { occurrenceId } = await context.params;

  try {
    const detail = await loadOccurrenceDetail(ctx.supabase, ctx.organizationId, occurrenceId);
    return Response.json({ occurrence: detail });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Occurrence not found", 404);
  }
}
