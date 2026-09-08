#!/usr/bin/env node
/** Verify migration 029 applied on controlled production database. */
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const PHASE12_TABLES = [
  "teller_workers",
  "teller_payroll_runs",
  "teller_payroll_components",
  "teller_payroll_account_mappings",
  "teller_labor_entries",
  "teller_payroll_liability_settlements",
];

const M029 = resolve(process.cwd(), "supabase/migrations/029_phase12_payroll_labor.sql");

async function restProbe(supabase) {
  const checks = {};
  for (const table of PHASE12_TABLES) {
    const { error } = await supabase.from(table).select("id").limit(0);
    checks[`table_${table}`] = !error;
    if (error) checks[`table_${table}_error`] = error.message;
  }

  const columnProbes = [
    ["teller_payroll_runs", "organization_id, provider, external_run_id, status, journal_entry_id, idempotency_key, reversal_journal_entry_id"],
    ["teller_workers", "organization_id, external_provider, external_worker_id, display_name, worker_type"],
    ["teller_labor_entries", "organization_id, worker_id, payroll_run_id, job_id, gross_amount, employer_burden_amount, labor_type"],
    ["teller_payroll_components", "organization_id, payroll_run_id, component_category, amount, worker_id"],
    ["teller_payroll_account_mappings", "organization_id, component_category, account_id, side"],
    ["teller_payroll_liability_settlements", "organization_id, settlement_type, liability_account_id, cash_account_id, idempotency_key"],
  ];
  for (const [table, cols] of columnProbes) {
    const { error } = await supabase.from(table).select(cols).limit(0);
    checks[`columns_${table}`] = !error;
  }

  const { error: postError } = await supabase.rpc("teller_post_journal", {
    p_org: "00000000-0000-0000-0000-000000000000",
    p_entry_date: "2099-01-01",
    p_memo: "probe",
    p_lines: [],
    p_source: "probe",
    p_idempotency_key: "probe",
  });
  checks.teller_post_journal_exists = Boolean(postError && !/function.*does not exist/i.test(postError.message));

  const m028Tables = ["teller_accrual_settlements", "teller_scheduler_runs"];
  for (const table of m028Tables) {
    const { error } = await supabase.from(table).select("id").limit(0);
    checks[`phase11_1_${table}`] = !error;
  }

  return checks;
}

async function pgDeepChecks(client) {
  const checks = {};
  const { rows: tableRows } = await client.query(
    `select tablename from pg_tables where schemaname = 'public' and tablename = any($1::text[])`,
    [PHASE12_TABLES],
  );
  for (const table of PHASE12_TABLES) {
    checks[`pg_table_${table}`] = tableRows.some((r) => r.tablename === table);
  }

  const { rows: rlsRows } = await client.query(
    `select c.relname as table_name, c.relrowsecurity as rls_enabled
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = any($1::text[])`,
    [PHASE12_TABLES],
  );
  for (const table of PHASE12_TABLES) {
    checks[`rls_${table}`] = rlsRows.some((r) => r.table_name === table && r.rls_enabled === true);
  }

  const { rows: uniqRows } = await client.query(
    `select conname, conrelid::regclass::text as table_name from pg_constraint
     where conname like '%payroll%' and contype = 'u'`,
  );
  checks.payroll_idempotency_constraints = uniqRows.length >= 1;

  const { rows: postJournalRows } = await client.query(
    `select pg_get_function_identity_arguments(p.oid) as args
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'teller_post_journal'`,
  );
  checks.teller_post_journal_signatures = postJournalRows.map((r) => r.args);

  return checks;
}

async function main() {
  loadControlledProdEnv();
  const migrationSql = readFileSync(M029, "utf8");
  if (/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(migrationSql)) {
    console.log(JSON.stringify({ ok: false, reason: "029 must not replace teller_post_journal" }, null, 2));
    process.exit(1);
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const checks = await restProbe(supabase);
  let pgChecks = {};

  const dbUrl = process.env.SUPABASE_DB_URL?.trim();
  if (dbUrl) {
    assertProductionDbUrl(dbUrl);
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      pgChecks = await pgDeepChecks(client);
    } finally {
      await client.end();
    }
  } else {
    pgChecks.pg_catalog_skipped = true;
  }

  const merged = { ...checks, ...pgChecks };
  const required = Object.entries(merged).filter(
    ([key, value]) =>
      !key.endsWith("_error") &&
      key !== "teller_post_journal_signatures" &&
      key !== "pg_catalog_skipped" &&
      key !== "payroll_idempotency_constraints",
  );
  const ok = required.every(([, value]) => value === true);

  console.log(JSON.stringify({ ok, MIGRATION_029_VERIFIED: ok, checks: merged }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
