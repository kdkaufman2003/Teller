import { jsonError, requireBooks } from "@/lib/api";
import { loadEligibleDepositSources } from "@/lib/accounting/schedules/schedule-crud";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  try {
    const sources = await loadEligibleDepositSources(ctx.supabase, ctx.organizationId);
    return Response.json({ sources });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load deposit sources", 400);
  }
}
