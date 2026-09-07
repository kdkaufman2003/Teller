import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { loadSchedulerConfig } from "./scheduler-config";
import { processDueScheduleOccurrences, type ProcessDueResult } from "./process-due";

export type SchedulerRunSummary = {
  runId: string;
  status: "running" | "completed" | "failed" | "partial";
  triggerType: "cron" | "manual" | "dry_run";
  dryRun: boolean;
  schedulesScanned: number;
  occurrencesGenerated: number;
  occurrencesPosted: number;
  failures: number;
  durationMs: number;
  orgResults: Array<{ organizationId: string; result: ProcessDueResult }>;
};

export async function startSchedulerRun(
  supabase: SupabaseClient,
  input: {
    runId?: string;
    organizationId?: string | null;
    triggerType: "cron" | "manual" | "dry_run";
    dryRun?: boolean;
  },
) {
  const runId = input.runId ?? randomUUID();
  const config = loadSchedulerConfig();
  const { error } = await supabase.from("teller_scheduler_runs").insert({
    run_id: runId,
    organization_id: input.organizationId ?? null,
    trigger_type: input.triggerType,
    status: "running",
    dry_run: input.dryRun ?? config.dryRun,
    started_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return runId;
}

export async function finishSchedulerRun(
  supabase: SupabaseClient,
  input: {
    runId: string;
    summary: Omit<SchedulerRunSummary, "runId">;
  },
) {
  const { error } = await supabase
    .from("teller_scheduler_runs")
    .update({
      status: input.summary.status,
      finished_at: new Date().toISOString(),
      schedules_scanned: input.summary.schedulesScanned,
      occurrences_generated: input.summary.occurrencesGenerated,
      occurrences_posted: input.summary.occurrencesPosted,
      failures: input.summary.failures,
      duration_ms: input.summary.durationMs,
      metadata: { orgResults: input.summary.orgResults.map((row) => ({ organizationId: row.organizationId, ...row.result })) },
    })
    .eq("run_id", input.runId);
  if (error) throw new Error(error.message);
}

export async function listActiveOrganizations(
  supabase: SupabaseClient,
  limit: number,
): Promise<string[]> {
  const { data } = await supabase
    .from("teller_accounting_schedules")
    .select("organization_id")
    .eq("status", "active")
    .limit(limit * 10);

  const ids = [...new Set((data ?? []).map((row) => row.organization_id as string))];
  return ids.slice(0, limit);
}

export async function runBoundedSchedulerForOrg(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    asOfDate: string;
    actorId?: string | null;
    autoPost?: boolean;
    batchSize: number;
    deadlineMs: number;
    startedAt: number;
  },
): Promise<ProcessDueResult> {
  const remainingMs = input.deadlineMs - (Date.now() - input.startedAt);
  if (remainingMs <= 0) {
    return { processed: 0, skipped: 0, failed: 0, results: [{ occurrenceId: "", status: "skipped", detail: "time budget exceeded" }] };
  }

  return processDueScheduleOccurrences(supabase, {
    organizationId: input.organizationId,
    asOfDate: input.asOfDate,
    actorId: input.actorId,
    autoPost: input.autoPost,
    batchSize: input.batchSize,
  });
}

export async function runProductionScheduler(
  supabase: SupabaseClient,
  input: {
    asOfDate: string;
    organizationIds?: string[];
    actorId?: string | null;
    triggerType?: "cron" | "manual" | "dry_run";
  },
): Promise<SchedulerRunSummary> {
  const config = loadSchedulerConfig();
  const startedAt = Date.now();
  const runId = randomUUID();
  const dryRun = config.dryRun || input.triggerType === "dry_run";
  const triggerType = input.triggerType ?? (dryRun ? "dry_run" : "cron");

  await startSchedulerRun(supabase, {
    runId,
    triggerType,
    dryRun,
  });

  const orgIds =
    input.organizationIds ??
    (await listActiveOrganizations(supabase, config.batchSize));

  const orgResults: SchedulerRunSummary["orgResults"] = [];
  let schedulesScanned = 0;
  let occurrencesGenerated = 0;
  let occurrencesPosted = 0;
  let failures = 0;

  for (const organizationId of orgIds) {
    if (Date.now() - startedAt >= config.maxExecutionMs) break;

    try {
      const result = await runBoundedSchedulerForOrg(supabase, {
        organizationId,
        asOfDate: input.asOfDate,
        actorId: input.actorId,
        autoPost: !dryRun && config.enabled,
        batchSize: config.batchSize,
        deadlineMs: config.maxExecutionMs,
        startedAt,
      });
      orgResults.push({ organizationId, result });
      schedulesScanned += result.processed + result.skipped + result.failed;
      occurrencesGenerated += result.results.filter((row) => row.status === "generated").length;
      occurrencesPosted += result.results.filter((row) => row.status === "posted").length;
      failures += result.failed;
    } catch (error) {
      failures += 1;
      orgResults.push({
        organizationId,
        result: {
          processed: 0,
          skipped: 0,
          failed: 1,
          results: [{ occurrenceId: organizationId, status: "failed", detail: error instanceof Error ? error.message : String(error) }],
        },
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  const status: SchedulerRunSummary["status"] =
    failures > 0 && orgResults.some((row) => row.result.processed > 0)
      ? "partial"
      : failures > 0
        ? "failed"
        : "completed";

  const summary: Omit<SchedulerRunSummary, "runId"> = {
    status,
    triggerType,
    dryRun,
    schedulesScanned,
    occurrencesGenerated,
    occurrencesPosted,
    failures,
    durationMs,
    orgResults,
  };

  await finishSchedulerRun(supabase, { runId, summary });

  return { runId, ...summary };
}
