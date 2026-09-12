import { NextResponse } from "next/server";
import { initializeEntityCoa } from "@/lib/accounting/entity-books";
import { jsonError, requireAccountingWriteBooks } from "@/lib/api";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { id: legalEntityId } = await context.params;
  const ctx = await requireAccountingWriteBooks({ requestedLegalEntityId: legalEntityId });
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const body = (await request.json()) as {
    mode?: "standard" | "copy_structure";
    sourceLegalEntityId?: string | null;
  };
  const mode = body.mode ?? "standard";
  if (mode !== "standard" && mode !== "copy_structure") {
    return jsonError("mode must be standard or copy_structure", 400);
  }

  try {
    const result = await initializeEntityCoa(supabase, {
      organizationId,
      legalEntityId,
      mode,
      sourceLegalEntityId: body.sourceLegalEntityId,
    });
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not initialize COA", 400);
  }
}
