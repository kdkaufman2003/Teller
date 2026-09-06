#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const HFAC_BASELINE = { documents: 8, payments: 3, payment_allocations: 3, journal_entries: 16 };

const PHASE7_OBJECTS = [
  "teller_document_sequences",
  "teller_job_cost_categories",
  "teller_job_budget_lines",
];

const PHASE7_COLUMNS = [
  ["teller_jobs", "estimated_revenue"],
  ["teller_jobs", "closed_at"],
  ["teller_document_lines", "cost_classification"],
  ["teller_journal_lines", "cost_classification"],
  ["teller_journal_lines", "job_cost_category_id"],
];

const LEGACY_STATUSES = ["estimate", "scheduled", "in_progress", "complete", "invoiced", "cancelled"];

function readMigration() {
  const path = resolve(process.cwd(), "supabase/migrations/023_phase7_job_costing.sql");
  if (!existsSync(path)) throw new Error("Missing 023_phase7_job_costing.sql");
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

async function main() {
  loadControlledProdEnv();
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");

  const migration = readMigration();
  const staticOk =
    migration.includes("teller_job_cost_categories") &&
    migration.includes("teller_allocate_sequence_number") &&
    migration.includes("cost_classification");

  const unit = run("npm", ["test"]);
  const build = run("npm", ["run", "build"]);
  const deploymentCompat = run("node", ["scripts/audit-phase7-deployment-compat.mjs"]);
  let compatReport = {};
  try {
    const jsonStart = deploymentCompat.output.indexOf("{");
    compatReport = JSON.parse(deploymentCompat.output.slice(jsonStart));
  } catch {
    compatReport = { parseError: true, output: deploymentCompat.output };
  }

  const legacyStatusOk = LEGACY_STATUSES.every((s) => migration.includes(`'${s}'`));
  const newStatusOk = ["draft", "active", "on_hold", "completed", "closed"].every((s) =>
    migration.includes(`'${s}'`),
  );
  const STATUS_DEPLOYMENT_COMPATIBLE = legacyStatusOk && newStatusOk;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const tables = {};
  for (const table of PHASE7_OBJECTS) tables[table] = await tableExists(supabase, table);
  const columns = {};
  for (const [table, column] of PHASE7_COLUMNS) columns[`${table}.${column}`] = await columnExists(supabase, table, column);

  const schemaApplied = Object.values(tables).every(Boolean) && Object.values(columns).every(Boolean);
  const hfac = await hfacBaseline(supabase);
  const hfacUnchanged =
    hfac.documents === HFAC_BASELINE.documents &&
    hfac.payments === HFAC_BASELINE.payments &&
    hfac.payment_allocations === HFAC_BASELINE.payment_allocations &&
    hfac.journal_entries === HFAC_BASELINE.journal_entries;
  const SAFE_TO_APPLY_023 =
    staticOk &&
    !schemaApplied &&
    unit.ok &&
    build.ok &&
    deploymentCompat.ok &&
    Boolean(compatReport.SAFE_TO_APPLY_023);
  const PHASE_7_COMPLETE =
    schemaApplied && unit.ok && build.ok && deploymentCompat.ok && hfacUnchanged;

  console.log(
    JSON.stringify(
      {
        LOCAL_TESTS: unit.ok,
        BUILD: build.ok,
        OLD_APP_COMPATIBLE_WITH_023: compatReport.OLD_APP_COMPATIBLE_WITH_023 ?? null,
        OLD_POST_JOURNAL_CALLERS_COMPATIBLE: compatReport.OLD_POST_JOURNAL_CALLERS_COMPATIBLE ?? null,
        HFAC_USES_ATOMIC_JOB_NUMBERING: compatReport.HFAC_USES_ATOMIC_JOB_NUMBERING ?? null,
        STATUS_DEPLOYMENT_COMPATIBLE:
          compatReport.STATUS_DEPLOYMENT_COMPATIBLE ?? STATUS_DEPLOYMENT_COMPATIBLE,
        staticMigrationReview: { ok: staticOk },
        deploymentCompatAudit: compatReport,
        schemaApplied,
        schemaProbe: { tables, columns },
        hfacBaseline: hfac,
        hfacBaselineUnchanged: hfacUnchanged,
        SAFE_TO_APPLY_023,
        PHASE_7_COMPLETE,
        deferredUi: ["customer detail related-jobs panel"],
        READY_FOR_PHASE7_CONTROLLED_PRODUCTION_MIGRATION: (SAFE_TO_APPLY_023 && hfacUnchanged) || (schemaApplied && unit.ok && build.ok),
        nextStep: schemaApplied
          ? "Run npm run setup:phase7-demo-org then npm run demo:phase7:controlled"
          : "Apply 023 via npm run migrate:phase7:controlled after approval",
      },
      null,
      2,
    ),
  );

  process.exit(unit.ok && build.ok && deploymentCompat.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
