#!/usr/bin/env node
/** Verify migration 035 tax accounting objects on controlled production database. */
import pg from "pg";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const M035 = resolve(process.cwd(), "supabase/migrations/035_phase15_tax_accounting.sql");

const TABLES = [
  "teller_tax_authorities",
  "teller_tax_rate_components",
  "teller_tax_settings",
  "teller_tax_registrations",
  "teller_tax_categories",
  "teller_taxability_rules",
  "teller_tax_exemptions",
  "teller_tax_transactions",
  "teller_tax_transaction_components",
  "teller_tax_determination_snapshots",
  "teller_tax_audit_events",
];

const TRIGGERS = [
  "teller_tax_settings_org_guard",
  "teller_tax_exemptions_org_guard",
  "teller_tax_transactions_org_guard",
  "teller_tax_tx_components_org_guard",
  "teller_tax_transactions_posted_guard",
  "teller_tax_det_snapshots_immutable",
];

async function restProbe(supabase) {
  const checks = {};
  for (const table of TABLES) {
    const { error } = await supabase.from(table).select("id", { head: true, count: "exact" }).limit(1);
    checks[`table_${table}`] = !error || !/does not exist|schema cache/i.test(error.message);
    if (error) checks[`table_${table}_error`] = error.message;
  }

  const { error: jurisdictionError } = await supabase
    .from("teller_tax_jurisdictions")
    .select("jurisdiction_type, parent_jurisdiction_key")
    .limit(1);
  checks.table_teller_tax_jurisdictions_extended =
    !jurisdictionError || !/does not exist|schema cache|column/i.test(jurisdictionError.message);
  if (jurisdictionError) checks.table_teller_tax_jurisdictions_extended_error = jurisdictionError.message;

  const { error: postError } = await supabase.rpc("teller_post_journal", {
    p_organization_id: "00000000-0000-0000-0000-000000000000",
    p_entry_date: "2099-01-01",
    p_memo: "probe",
    p_source_kind: "probe",
    p_source_id: null,
    p_reverses_entry_id: null,
    p_lines: [],
  });
  checks.teller_post_journal_unchanged = !postError || !/does not exist|function.*does not exist/i.test(postError.message);

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

  const { rows: colRows } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'teller_tax_jurisdictions'
       and column_name in ('parent_jurisdiction_key', 'jurisdiction_type')`,
  );
  checks.pg_jurisdiction_hierarchy_columns = colRows.length === 2;

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

  const migrationSql = readFileSync(M035, "utf8");
  checks.migration_does_not_replace_post_journal =
    !/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(migrationSql);

  return checks;
}

async function main() {
  loadControlledProdEnv();
  if (!existsSync(M035)) {
    console.log(JSON.stringify({ ok: false, reason: "missing 035 migration file" }, null, 2));
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
        MIGRATION_035_OBJECT_VERIFY: objectOk ? "PASS" : "FAIL",
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
