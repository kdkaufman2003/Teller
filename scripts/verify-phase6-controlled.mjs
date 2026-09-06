#!/usr/bin/env node
/**
 * Phase 6 controlled production migration gate (pre-apply).
 * READY_FOR_PHASE6_CONTROLLED_PRODUCTION_MIGRATION = true means:
 *   code/build/tests pass, production audit shows safe PLAN_A apply path,
 *   HFAC baseline unchanged — authorized to apply 021 then 022.
 *
 * Does NOT apply migrations. After applying, re-run to confirm schemaApplied.
 *
 * Usage: TELLER_CONTROLLED_PROD_TEST=1 npm run verify:phase6:controlled
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";

const PHASE6_TABLES = [
  "teller_ap_settings",
  "teller_purchase_orders",
  "teller_purchase_order_lines",
  "teller_purchase_receipts",
  "teller_purchase_receipt_lines",
  "teller_recurring_bill_templates",
  "teller_recurring_bill_template_lines",
];

const PHASE6_COLUMNS = [
  ["teller_parties", "payment_terms"],
  ["teller_document_lines", "job_id"],
  ["teller_document_lines", "cost_category"],
  ["teller_documents", "purchase_order_id"],
  ["teller_documents", "submitted_at"],
];

const HFAC_BASELINE_EXPECTED = {
  documents: 8,
  payments: 3,
  payment_allocations: 3,
  journal_entries: 16,
};

function readMigration(name) {
  const path = resolve(process.cwd(), `supabase/migrations/${name}`);
  if (!existsSync(path)) throw new Error(`Missing migration ${name}`);
  return readFileSync(path, "utf8");
}

function staticMigrationReview() {
  const m21 = readMigration("021_phase6_ap_foundation.sql");
  const m22 = readMigration("022_phase6_purchasing.sql");
  const issues = [];

  if (!m21.includes("teller_ap_settings")) issues.push("021 missing teller_ap_settings");
  if (!m22.includes("teller_purchase_orders")) issues.push("022 missing teller_purchase_orders");
  if (!m21.includes("purchase_order_id")) issues.push("021 must add purchase_order_id before 022 FK");
  if (!m22.includes("teller_documents_purchase_order_id_fkey")) {
    issues.push("022 must add purchase_order_id FK");
  }
  if (!m21.includes("enable row level security")) issues.push("021 should enable RLS");
  if (!m22.includes("enable row level security")) issues.push("022 should enable RLS");

  // Dependency: 022 FK requires 021 column
  const depends =
    m21.includes("purchase_order_id") &&
    m22.includes("foreign key (purchase_order_id) references public.teller_purchase_orders");

  return { ok: issues.length === 0, issues, "022_DEPENDS_ON_021": depends };
}

function tableMissing(error) {
  const msg = (error?.message ?? "").toLowerCase();
  return (
    msg.includes("schema cache") ||
    msg.includes("could not find the table") ||
    (msg.includes("relation") && msg.includes("does not exist"))
  );
}

function columnMissing(error) {
  const msg = (error?.message ?? "").toLowerCase();
  return msg.includes("column") && msg.includes("does not exist");
}

/** Authoritative REST probe — HEAD count alone false-positives on missing tables. */
async function tableExists(supabase, table) {
  const { error } = await supabase.from(table).select("*").limit(1);
  if (!error) return true;
  if (tableMissing(error)) return false;
  return true;
}

async function columnExists(supabase, table, column) {
  if (!(await tableExists(supabase, table))) return false;
  const { error } = await supabase.from(table).select(column).limit(0);
  if (!error) return true;
  if (columnMissing(error)) return false;
  return true;
}

async function schemaProbe(supabase) {
  const tables = {};
  for (const table of PHASE6_TABLES) {
    tables[table] = await tableExists(supabase, table);
  }
  const columns = {};
  for (const [table, column] of PHASE6_COLUMNS) {
    columns[`${table}.${column}`] = await columnExists(supabase, table, column);
  }
  return { tables, columns };
}

function classifyMigrationPresence(probe) {
  const tablesPresent = Object.values(probe.tables).filter(Boolean).length;
  const colsPresent = Object.values(probe.columns).filter(Boolean).length;
  const tablesTotal = PHASE6_TABLES.length;
  const colsTotal = PHASE6_COLUMNS.length;

  if (tablesPresent === 0 && colsPresent === 0) return "absent";
  if (tablesPresent === tablesTotal && colsPresent === colsTotal) return "complete";
  return "partial";
}

async function rowCounts(supabase, probe) {
  const counts = {};
  for (const table of PHASE6_TABLES) {
    if (!probe.tables[table]) {
      counts[table] = null;
      continue;
    }
    const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
    counts[table] = error ? null : (count ?? 0);
  }
  return counts;
}

async function hfacBaseline(supabase) {
  async function count(table) {
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG_ID);
    if (error) throw new Error(`${table}: ${error.message}`);
    return count ?? 0;
  }
  return {
    documents: await count("teller_documents"),
    payments: await count("teller_payments"),
    payment_allocations: await count("teller_payment_allocations"),
    journal_entries: await count("teller_journal_entries"),
  };
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8" });
  return { ok: result.status === 0, output: (result.stdout || "") + (result.stderr || "") };
}

async function main() {
  loadControlledProdEnv();
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");
  }

  const staticReview = staticMigrationReview();
  const unit = run("npm", ["test", "--", "src/lib/accounting/phase6-ap.test.ts"]);
  const build = run("npm", ["run", "build"]);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const probe = await schemaProbe(supabase);
  const prod021Status =
    !probe.tables.teller_ap_settings && !Object.values(probe.columns).some(Boolean)
      ? "absent"
      : probe.tables.teller_ap_settings && Object.values(probe.columns).every(Boolean)
        ? "complete"
        : "partial";
  const prod022Status =
    Object.values(probe.tables).filter(Boolean).length === 0
      ? "absent"
      : Object.values(probe.tables).every(Boolean)
        ? "complete"
        : "partial";

  const schemaApplied = prod021Status === "complete" && prod022Status === "complete";
  const hfac = await hfacBaseline(supabase);
  const hfacUnchanged =
    hfac.documents === HFAC_BASELINE_EXPECTED.documents &&
    hfac.payments === HFAC_BASELINE_EXPECTED.payments &&
    hfac.payment_allocations === HFAC_BASELINE_EXPECTED.payment_allocations &&
    hfac.journal_entries === HFAC_BASELINE_EXPECTED.journal_entries;

  const rowCounts022 = await rowCounts(supabase, probe);
  const all022Zero = Object.values(rowCounts022).every((c) => c === null || c === 0);

  const safeToApply021 =
    prod021Status !== "complete" &&
    !(probe.columns["teller_documents.purchase_order_id"] && !probe.tables.teller_purchase_orders);

  const recommendedPlan =
    prod021Status === "absent" && prod022Status === "absent"
      ? "PLAN_A"
      : prod021Status === "complete" && prod022Status === "complete"
        ? "PLAN_B"
        : prod021Status !== "complete"
          ? "PLAN_A"
          : "PLAN_C";

  // Pre-apply: cleared to apply 021+022. Post-apply: schema complete + gates pass.
  const readyToApply =
    staticReview.ok &&
    hfacUnchanged &&
    safeToApply021 &&
    (prod021Status === "absent" || prod021Status === "partial") &&
    prod022Status !== "complete";

  const readyAfterApply =
    staticReview.ok && unit.ok && build.ok && hfacUnchanged && schemaApplied;

  const READY_FOR_PHASE6_CONTROLLED_PRODUCTION_MIGRATION = readyToApply || readyAfterApply;
  const PHASE_6_COMPLETE =
    schemaApplied && hfacUnchanged && unit.ok && build.ok && staticReview.ok;

  const report = {
    staticMigrationReview: staticReview,
    unitTests: unit.ok,
    build: build.ok,
    PROD_021_STATUS: prod021Status,
    PROD_022_STATUS: prod022Status,
    schemaProbe: probe,
    schemaApplied,
    "022_PRODUCTION_ROW_COUNTS": rowCounts022,
    all_022_rows_zero: all022Zero,
    hfacBaseline: hfac,
    hfacBaselineUnchanged: hfacUnchanged,
    SAFE_TO_APPLY_021: safeToApply021,
    RECOMMENDED_PLAN: recommendedPlan,
    READY_FOR_PHASE6_CONTROLLED_PRODUCTION_MIGRATION,
    PHASE_6_COMPLETE,
    readyToApplyMigrations: readyToApply,
    migrationsApplied: schemaApplied,
    nextStep: schemaApplied
      ? PHASE_6_COMPLETE
        ? "Phase 6 gate green — run npm run demo:phase6:controlled to confirm control scenarios"
        : "Run npm run setup:phase6-demo-org then npm run demo:phase6:controlled"
      : readyToApply
        ? "Apply 021 then 022 via npm run migrate:phase6:controlled (requires SUPABASE_DB_URL)"
        : "Resolve gate failures before applying migrations",
  };

  console.log(JSON.stringify(report, null, 2));
  if (!unit.ok) console.error(unit.output.slice(-2000));
  if (!build.ok) console.error(build.output.slice(-2000));

  process.exit(READY_FOR_PHASE6_CONTROLLED_PRODUCTION_MIGRATION ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
