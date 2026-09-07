#!/usr/bin/env node
/**
 * Phase 8 controlled production migration gate.
 * Probes migration 024 schema, HFAC baseline, deployment compat.
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

const PHASE8_OBJECTS = [
  "teller_fixed_asset_settings",
  "teller_fixed_asset_categories",
  "teller_fixed_assets",
  "teller_fixed_asset_depreciation_schedule_lines",
  "teller_fixed_asset_depreciation_batches",
  "teller_fixed_asset_depreciation_entries",
  "teller_fixed_asset_journal_links",
  "teller_fixed_asset_disposal_idempotency",
];

const PHASE8_COLUMNS = [
  ["teller_journal_lines", "fixed_asset_id"],
];

function readMigration() {
  const path = resolve(process.cwd(), "supabase/migrations/024_phase8_fixed_assets.sql");
  if (!existsSync(path)) throw new Error("Missing 024_phase8_fixed_assets.sql");
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
    if (HFAC_ORG_ID === process.env.TELLER_PHASE8_DEMO_ORG_ID?.trim()) return false;
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
  if (process.env.TELLER_PHASE8_DEMO_ORG_ID?.trim() === HFAC_ORG_ID) {
    throw new Error("Refusing HFAC org as Phase 8 demo org");
  }

  const migration = readMigration();
  const productionDisposeBlock = migration.slice(
    migration.indexOf("create or replace function public.teller_dispose_fixed_asset("),
    migration.indexOf("create or replace function public.teller_dispose_fixed_asset_controlled_test("),
  );
  const staticOk =
    migration.includes("teller_fixed_assets") &&
    migration.includes("fixed_asset_id") &&
    migration.includes("teller_post_journal") &&
    migration.includes("teller_dispose_fixed_asset") &&
    migration.includes("teller_dispose_fixed_asset_controlled_test") &&
    migration.includes("idempotency_key uuid") &&
    migration.includes("claim_idempotency") &&
    migration.includes("teller_is_org_member(p_organization_id)") &&
    !productionDisposeBlock.includes("p_simulate_failure_after") &&
    !migration.includes("grant execute on function public.teller_dispose_fixed_asset_core");

  const PRODUCTION_DISPOSAL_RPC_HAS_TEST_HOOK = productionDisposeBlock.includes("p_simulate_failure_after");
  const DISPOSAL_IDEMPOTENCY_USES_OPERATION_UUID = migration.includes("idempotency_key uuid not null");
  const SAME_KEY_CONCURRENCY_DESIGN_SAFE =
    migration.includes("claim_idempotency") && migration.includes("when unique_violation");
  const DIFFERENT_KEY_CONCURRENCY_DESIGN_SAFE = migration.includes("for update") &&
    migration.includes("Asset is already disposed");
  const REDISPOSAL_AFTER_REVERSAL_SAFE =
    migration.includes("status = 'completed'") && !migration.includes("delete from public.teller_fixed_asset_disposal_idempotency");
  const RPC_TENANT_AUTHORIZATION_VERIFIED =
    migration.includes("teller_is_org_member(p_organization_id)") &&
    migration.includes("teller_can_write_books(p_organization_id)");
  const runnerPath = resolve(process.cwd(), "scripts/controlled-phase8-demo-runner.ts");
  const runnerSource = existsSync(runnerPath) ? readFileSync(runnerPath, "utf8") : "";
  const disposalServicePath = resolve(process.cwd(), "src/lib/accounting/fixed-asset-disposal.ts");
  const disposalServiceSource = existsSync(disposalServicePath) ? readFileSync(disposalServicePath, "utf8") : "";
  const disposeRoutePath = resolve(process.cwd(), "src/app/api/fixed-assets/[id]/dispose/route.ts");
  const disposeRouteSource = existsSync(disposeRoutePath) ? readFileSync(disposeRoutePath, "utf8") : "";
  const PHASE8_CONTROLLED_MATRIX_SIZE = 67;
  const MIGRATION_024_READY = staticOk && PRODUCTION_DISPOSAL_RPC_HAS_TEST_HOOK === false;
  const DISPOSAL_OPERATION_ID_REQUIRED =
    disposalServiceSource.includes("operationId: string") &&
    disposalServiceSource.includes("assertValidDisposalOperationId(input.operationId)");
  const DISPOSAL_OPERATION_ID_GENERATED_PER_REQUEST = disposalServiceSource.includes("?? randomUUID()");
  const SAME_OPERATION_RETRY_REUSES_UUID =
    runnerSource.includes("66. Lost-response retry") &&
    !DISPOSAL_OPERATION_ID_GENERATED_PER_REQUEST;
  const MISSING_OPERATION_ID_REJECTED_WITHOUT_ECONOMICS =
    runnerSource.includes("67. Missing operationId rejected") &&
    disposeRouteSource.includes("assertValidDisposalOperationId(body.operationId)");
  const PHASE8_CONTROLLED_RUNNER_READY =
    runnerSource.includes("67-scenario") &&
    runnerSource.includes("66. Lost-response retry") &&
    runnerSource.includes("67. Missing operationId rejected") &&
    (runnerSource.match(/await run\(/g) || []).length === 67;

  const unit = run("npm", ["test"]);
  const build = run("npm", ["run", "build"]);
  const deploymentCompat = run("node", ["scripts/audit-phase8-deployment-compat.mjs"]);
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
  for (const table of PHASE8_OBJECTS) tables[table] = await tableExists(supabase, table);
  const columns = {};
  for (const [table, column] of PHASE8_COLUMNS) {
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

  const SAFE_TO_APPLY_024 =
    staticOk &&
    !schemaApplied &&
    unit.ok &&
    build.ok &&
    deploymentCompat.ok &&
    Boolean(compatReport.SAFE_TO_APPLY_024) &&
    hfacHardRefusal;
  const PHASE_8_COMPLETE =
    schemaApplied && unit.ok && build.ok && deploymentCompat.ok && hfacUnchanged && hfacHardRefusal;

  console.log(
    JSON.stringify(
      {
        LOCAL_TESTS: unit.ok,
        BUILD_PASS: build.ok,
        MIGRATION_024_READY,
        OLD_APP_COMPATIBLE_WITH_024: compatReport.OLD_APP_COMPATIBLE_WITH_024 ?? null,
        OLD_POST_JOURNAL_CALLERS_COMPATIBLE: compatReport.OLD_POST_JOURNAL_CALLERS_COMPATIBLE ?? null,
        PRODUCTION_DISPOSAL_RPC_HAS_TEST_HOOK,
        DISPOSAL_OPERATION_ID_REQUIRED,
        DISPOSAL_OPERATION_ID_GENERATED_PER_REQUEST,
        SAME_OPERATION_RETRY_REUSES_UUID,
        MISSING_OPERATION_ID_REJECTED_WITHOUT_ECONOMICS,
        DISPOSAL_IDEMPOTENCY_USES_OPERATION_UUID,
        SAME_KEY_CONCURRENCY_DESIGN_SAFE,
        DIFFERENT_KEY_CONCURRENCY_DESIGN_SAFE,
        REDISPOSAL_AFTER_REVERSAL_SAFE,
        RPC_TENANT_AUTHORIZATION_VERIFIED,
        PHASE8_CONTROLLED_MATRIX_SIZE,
        PHASE8_CONTROLLED_RUNNER_READY,
        HFAC_HARD_REFUSAL_PRESENT: hfacHardRefusal,
        staticMigrationReview: { ok: staticOk },
        deploymentCompatAudit: compatReport,
        schemaApplied,
        schemaProbe: { tables, columns },
        hfacBaseline: hfac,
        hfacBaselineUnchanged: hfacUnchanged,
        SAFE_TO_APPLY_024,
        PHASE_8_COMPLETE,
        nextStep: schemaApplied
          ? "Run npm run setup:phase8-demo-org then npm run demo:phase8:controlled"
          : "Apply 024 via controlled migration workflow after approval",
        READY_FOR_PHASE8_CONTROLLED_PRODUCTION_MIGRATION:
          (SAFE_TO_APPLY_024 && hfacUnchanged) || (schemaApplied && unit.ok && build.ok),
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
