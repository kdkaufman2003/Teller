#!/usr/bin/env node
/** Verify migration 032 planning objects on controlled production database. */
import pg from "pg";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const M032 = resolve(process.cwd(), "supabase/migrations/032_phase14_planning.sql");

const TABLES = [
  "teller_planning_settings",
  "teller_budgets",
  "teller_budget_versions",
  "teller_budget_lines",
  "teller_planning_audit_events",
  "teller_forecasts",
  "teller_forecast_versions",
];

const RPCS = [
  "teller_atomic_approve_budget_version",
  "teller_atomic_lock_budget_version",
  "teller_atomic_clone_budget_version",
];

const TRIGGERS = [
  "teller_budget_versions_org_guard",
  "teller_budget_lines_org_guard",
  "teller_budget_lines_immutability_guard",
];

function rpcRestCallable(error) {
  if (!error) return true;
  const message = error.message ?? String(error);
  if (/function.*does not exist/i.test(message)) return false;
  if (/schema cache/i.test(message)) return false;
  if (/could not find the function/i.test(message)) return false;
  return true;
}

async function restProbe(supabase) {
  const checks = {};
  for (const table of TABLES) {
    const { error } = await supabase.from(table).select("id", { head: true, count: "exact" }).limit(1);
    checks[`table_${table}`] = !error || !/does not exist|schema cache/i.test(error.message);
    if (error) checks[`table_${table}_error`] = error.message;
  }

  for (const rpc of RPCS) {
    const args =
      rpc === "teller_atomic_clone_budget_version"
        ? {
            p_organization_id: "00000000-0000-0000-0000-000000000000",
            p_source_version_id: "00000000-0000-0000-0000-000000000000",
            p_actor_id: "00000000-0000-0000-0000-000000000000",
            p_label: "probe",
          }
        : {
            p_organization_id: "00000000-0000-0000-0000-000000000000",
            p_version_id: "00000000-0000-0000-0000-000000000000",
            p_actor_id: "00000000-0000-0000-0000-000000000000",
          };
    const { error } = await supabase.rpc(rpc, args);
    checks[`rpc_${rpc}`] = rpcRestCallable(error);
    if (error) checks[`rpc_${rpc}_error`] = error.message;
  }

  const { error: postError } = await supabase.rpc("teller_post_journal", {
    p_organization_id: "00000000-0000-0000-0000-000000000000",
    p_entry_date: "2099-01-01",
    p_memo: "probe",
    p_source_kind: "probe",
    p_source_id: null,
    p_reverses_entry_id: null,
    p_lines: [],
  });
  checks.teller_post_journal_unchanged = rpcRestCallable(postError);

  return checks;
}

async function pgDeepChecks(client) {
  const checks = {};
  const { rows: tableRows } = await client.query(
    `select tablename from pg_tables where schemaname = 'public' and tablename = any($1::text[])`,
    [TABLES],
  );
  for (const table of TABLES) {
    checks[`pg_table_${table}`] = tableRows.some((row) => row.tablename === table);
  }

  const { rows: rpcRows } = await client.query(
    `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any($1::text[])`,
    [RPCS],
  );
  for (const rpc of RPCS) {
    checks[`pg_${rpc}`] = rpcRows.some((row) => row.proname === rpc);
  }

  const { rows: triggerRows } = await client.query(
    `select tgname from pg_trigger where not tgisinternal and tgname = any($1::text[])`,
    [TRIGGERS],
  );
  for (const trigger of TRIGGERS) {
    checks[`pg_trigger_${trigger}`] = triggerRows.some((row) => row.tgname === trigger);
  }

  for (const table of TABLES) {
    const { rows } = await client.query(
      `select relrowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = $1`,
      [table],
    );
    checks[`pg_rls_${table}`] = rows[0]?.relrowsecurity === true;
  }

  const { rows: uniqueRows } = await client.query(
    `select indexname from pg_indexes
     where schemaname = 'public' and tablename = 'teller_budget_lines'
       and indexdef ilike '%unique%'`,
  );
  checks.pg_budget_line_unique_index = uniqueRows.length > 0;

  const migrationSql = readFileSync(M032, "utf8");
  checks.migration_does_not_replace_post_journal =
    !/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(migrationSql);

  return checks;
}

async function main() {
  loadControlledProdEnv();
  if (!existsSync(M032)) {
    console.log(JSON.stringify({ ok: false, reason: "missing 032 migration file" }, null, 2));
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
      key !== "pg_catalog_skipped" &&
      key !== "migration_does_not_replace_post_journal",
  );
  const objectOk = required.every(([, value]) => value === true);
  const postJournalOk =
    merged.teller_post_journal_unchanged === true &&
    merged.migration_does_not_replace_post_journal !== false;

  console.log(
    JSON.stringify(
      {
        ok: objectOk && postJournalOk,
        MIGRATION_032_OBJECT_VERIFY: objectOk ? "PASS" : "FAIL",
        TELLER_POST_JOURNAL_CHANGED: postJournalOk ? false : true,
        checks: merged,
      },
      null,
      2,
    ),
  );
  process.exit(objectOk && postJournalOk ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
