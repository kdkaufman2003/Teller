import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  PRODUCTION_SCHEDULER_ENABLED,
  assertSchedulerAuthorized,
  loadSchedulerConfig,
  RECOMMENDED_CRON_SCHEDULE,
} from "@/lib/accounting/schedules/scheduler-config";
import { runProductionScheduler } from "@/lib/accounting/schedules/scheduler-run";
import { jsonError } from "@/lib/api";

function serviceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service role is not configured");
  return createClient(url, key);
}

export async function GET(request: Request) {
  const config = loadSchedulerConfig();
  return NextResponse.json({
    enabled: PRODUCTION_SCHEDULER_ENABLED,
    dryRun: config.dryRun,
    batchSize: config.batchSize,
    maxExecutionMs: config.maxExecutionMs,
    eligibleTypes: config.eligibleTypes,
    recommendedCron: RECOMMENDED_CRON_SCHEDULE,
    note: "Cron is prepared but disabled until PRODUCTION_SCHEDULER_ENABLED=true",
  });
}

export async function POST(request: Request) {
  if (!PRODUCTION_SCHEDULER_ENABLED) {
    return NextResponse.json(
      {
        error: "Production scheduler is disabled",
        enabled: false,
        recommendedCron: RECOMMENDED_CRON_SCHEDULE,
      },
      { status: 503 },
    );
  }

  try {
    assertSchedulerAuthorized(request.headers.get("authorization"));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unauthorized", 401);
  }

  const body = (await request.json().catch(() => ({}))) as {
    asOfDate?: string;
    organizationIds?: string[];
    dryRun?: boolean;
  };
  const asOfDate = body.asOfDate ?? new Date().toISOString().slice(0, 10);

  try {
    const summary = await runProductionScheduler(serviceSupabase(), {
      asOfDate,
      organizationIds: body.organizationIds,
      triggerType: body.dryRun ? "dry_run" : "cron",
    });
    return NextResponse.json({ summary });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Scheduler run failed", 500);
  }
}
