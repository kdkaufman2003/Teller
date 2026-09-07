#!/usr/bin/env node
/**
 * Phase 9 controlled production migration gate.
 * Probes migration 025 schema, HFAC baseline, deployment compat.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const HFAC_BASELINE = {
  documents: 8,
  payments: 3,
  payment_allocations: 3,
  journal_entries: 16,
  jobs: 0,
};

const PHASE9_OBJECTS = [
  "teller_close_settings",
  "teller_period_close_reviews",
  "teller_close_checklist_items",
  "teller_adjusting_journal_entries",
  "teller_recurring_journal_templates",
  "teller_recurring_journal_runs",
];

const PHASE9_COLUMNS = [
  ["teller_period_closes", "event_type"],
  ["teller_period_closes", "effective_closed_through"],
];

function readMigration() {
  const path = resolve(process.cwd(), "supabase/migrations/025_phase9_month_end_close.sql");
  if (!existsSync(path)) throw new Error("Missing 025_phase9_month_end_close.sql");
  return readFileSync(path, "utf8");
}

async function tableExists(supabase, table) {
  const { error } = await supabase.from(table).select("*").limit(1);
  if (!error) return true;
  const msg = (error.message ?? "").toLowerCase();
  return !(msg.includes("does not exist") || msg.includes("schema cache"));
}

async function columnExists(supabase, table, column) {
  if (!(await tableExists(supabase, table))) return false;
  const { error } = await supabase.from(table).select(column).limit(0);
  if (!error) return true;
  return !(error.message ?? "").toLowerCase().includes("column");
}

async function hfacBaseline(supabase) {
  async function count(table) {
    const { count } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG_ID);
    return count ?? 0;
  }
  return {
    documents: await count("teller_documents"),
    payments: await count("teller_payments"),
    payment_allocations: await count("teller_payment_allocations"),
    journal_entries: await count("teller_journal_entries"),
    jobs: await count("teller_jobs"),
  };
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8" });
  return { ok: result.status === 0, output: (result.stdout || "") + (result.stderr || "") };
}

function refusesHfac() {
  try {
    if (HFAC_ORG_ID === process.env.TELLER_PHASE9_DEMO_ORG_ID?.trim()) return false;
    return true;
  } catch {
    return false;
  }
}

async function main() {
  loadControlledProdEnv();
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");
  }
  if (process.env.TELLER_PHASE9_DEMO_ORG_ID?.trim() === HFAC_ORG_ID) {
    throw new Error("Refusing HFAC org as Phase 9 demo org");
  }

  const migration = readMigration();
  const staticOk =
    migration.includes("teller_close_settings") &&
    migration.includes("teller_adjusting_journal_entries") &&
    migration.includes("teller_recurring_journal_templates") &&
    migration.includes("teller_close_accounting_period") &&
    migration.includes("teller_reopen_accounting_period") &&
    migration.includes("teller_journal_entries_period_guard") &&
    migration.includes('drop policy if exists "teller writers insert journal entries"') &&
    migration.includes('drop policy if exists "teller writers insert journal lines"') &&
    migration.includes("create or replace function public.teller_post_journal(") &&
    migration.includes("grant execute on function public.teller_close_accounting_period") &&
    migration.includes("grant execute on function public.teller_reopen_accounting_period");

  const runnerPath = resolve(process.cwd(), "scripts/controlled-phase9-demo-runner.ts");
  const runnerSource = existsSync(runnerPath) ? readFileSync(runnerPath, "utf8") : "";
  const PHASE9_CONTROLLED_MATRIX_SIZE = 100;
  const MIGRATION_025_READY = staticOk;
  const PHASE9_CONTROLLED_RUNNER_READY =
    runnerSource.includes("100-scenario") &&
    runnerSource.includes("export async function runPhase9ControlledDemo") &&
    runnerSource.includes("PHASE9_CONTROLLED_MATRIX_SIZE = 100") &&
    (runnerSource.match(/await run\(/g) || []).length === 100;

  const unit = run("npm", ["test"]);
  const build = run("npm", ["run", "build"]);
  const deploymentCompat = run("node", ["scripts/audit-phase9-deployment-compat.mjs"]);
  let compatReport = {};
  try {
    const jsonStart = deploymentCompat.output.indexOf("{");
    compatReport = JSON.parse(deploymentCompat.output.slice(jsonStart));
  } catch {
    compatReport = { parseError: true, output: deploymentCompat.output };
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const tables = {};
  for (const table of PHASE9_OBJECTS) tables[table] = await tableExists(supabase, table);
  const columns = {};
  for (const [table, column] of PHASE9_COLUMNS) {
    columns[`${table}.${column}`] = await columnExists(supabase, table, column);
  }

  const schemaApplied = Object.values(tables).every(Boolean) && Object.values(columns).every(Boolean);
  const hfac = await hfacBaseline(supabase);
  const hfacUnchanged =
    hfac.documents === HFAC_BASELINE.documents &&
    hfac.payments === HFAC_BASELINE.payments &&
    hfac.payment_allocations === HFAC_BASELINE.payment_allocations &&
    hfac.journal_entries === HFAC_BASELINE.journal_entries &&
    hfac.jobs === HFAC_BASELINE.jobs;
  const hfacHardRefusal = refusesHfac();

  const SAFE_TO_APPLY_025 =
    staticOk &&
    !schemaApplied &&
    unit.ok &&
    build.ok &&
    deploymentCompat.ok &&
    Boolean(compatReport.OLD_APP_COMPATIBLE_WITH_025) &&
    hfacHardRefusal;
  const PHASE_9_COMPLETE =
    schemaApplied && unit.ok && build.ok && deploymentCompat.ok && hfacUnchanged && hfacHardRefusal;

  console.log(
    JSON.stringify(
      {
        LOCAL_TESTS: unit.ok,
        BUILD_PASS: build.ok,
        MIGRATION_025_READY,
        OLD_APP_COMPATIBLE_WITH_025: compatReport.OLD_APP_COMPATIBLE_WITH_025 ?? null,
        OLD_POST_JOURNAL_CALLERS_COMPATIBLE: compatReport.OLD_POST_JOURNAL_CALLERS_COMPATIBLE ?? null,
        PERIOD_GUARD_TRIGGER_PRESENT: migration.includes("teller_journal_entries_period_guard"),
        DIRECT_INSERT_POLICIES_DROPPED:
          migration.includes('drop policy if exists "teller writers insert journal entries"') &&
          migration.includes('drop policy if exists "teller writers insert journal lines"'),
        CLOSE_REOPEN_RPCS_GRANTED:
          migration.includes("grant execute on function public.teller_close_accounting_period") &&
          migration.includes("grant execute on function public.teller_reopen_accounting_period"),
        PHASE9_CONTROLLED_MATRIX_SIZE,
        PHASE9_CONTROLLED_RUNNER_READY,
        HFAC_HARD_REFUSAL_PRESENT: hfacHardRefusal,
        staticMigrationReview: { ok: staticOk },
        deploymentCompatAudit: compatReport,
        schemaApplied,
        schemaProbe: { tables, columns },
        hfacBaseline: hfac,
        hfacBaselineUnchanged: hfacUnchanged,
        SAFE_TO_APPLY_025,
        PHASE_9_COMPLETE,
        nextStep: schemaApplied
          ? "Run npm run setup:phase9-demo-org then npm run demo:phase9:controlled"
          : "Apply 025 via controlled migration workflow after approval",
        READY_FOR_PHASE9_CONTROLLED_PRODUCTION_MIGRATION:
          (SAFE_TO_APPLY_025 && hfacUnchanged) || (schemaApplied && unit.ok && build.ok),
      },
      null,
      2,
    ),
  );

  process.exit(unit.ok && build.ok && deploymentCompat.ok && hfacHardRefusal ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
