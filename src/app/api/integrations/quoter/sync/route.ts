import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { syncQuoter } from "@/lib/integrations/quoter";
import { isQuoterSharedSupabase } from "@/lib/supabase/env";
import { createServiceClient, hasServiceRole } from "@/lib/supabase/admin";

export async function POST() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { session, organizationId, supabase } = ctx;

  if (!isQuoterSharedSupabase()) {
    return jsonError("Shared Quoter Supabase sync is disabled", 400);
  }

  const createJobs = Boolean(session.settings?.modules?.includes("jobs"));
  const client = hasServiceRole() ? createServiceClient() : supabase;

  try {
    const summary = await syncQuoter(client, organizationId, createJobs);
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    return jsonError(message, 500);
  }
}
