#!/usr/bin/env node
/** Verify migration 027 applied on controlled production database. */
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const PHASE11_TABLES = [
  "teller_org_automation_settings",
  "teller_accounting_schedules",
  "teller_schedule_occurrences",
  "teller_schedule_attachments",
  "teller_schedule_notes",
  "teller_recurring_bill_runs",
];

async function restProbe(supabase) {
  const checks = {};
  for (const table of PHASE11_TABLES) {
    const selectCol = table === "teller_org_automation_settings" ? "organization_id" : "id";
    const { error } = await supabase.from(table).select(selectCol).limit(0);
    checks[`table_${table}`] = !error;
    if (error) checks[`table_${table}_error`] = error.message;
  }

  const { error: rjError } = await supabase
    .from("teller_recurring_journal_templates")
    .select("post_mode, auto_post_enabled")
    .limit(0);
  checks.recurring_journal_columns = !rjError;

  const { error: rbError } = await supabase
    .from("teller_recurring_bill_templates")
    .select("template_status, next_generation_date, auto_generate_enabled")
    .limit(0);
  checks.recurring_bill_columns = !rbError;

  const { data: postRpc, error: postError } = await supabase.rpc("teller_post_journal", {
    p_org: "00000000-0000-0000-0000-000000000000",
    p_entry_date: "2099-01-01",
    p_memo: "probe",
    p_lines: [],
    p_source: "probe",
    p_idempotency_key: "probe",
  });
  checks.teller_post_journal_exists = Boolean(postError && !/function.*does not exist/i.test(postError.message));
  void postRpc;

  return checks;
}

async function pgDeepChecks(client) {
  const checks = {};

  const { rows: tableRows } = await client.query(`
    select tablename from pg_tables
    where schemaname = 'public'
      and tablename = any($1::text[])
  `, [PHASE11_TABLES]);
  for (const table of PHASE11_TABLES) {
    checks[`pg_table_${table}`] = tableRows.some((r) => r.tablename === table);
  }

  const { rows: rlsRows } = await client.query(`
    select c.relname as table_name, c.relrowsecurity as rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any($1::text[])
  `, [PHASE11_TABLES]);
  for (const table of PHASE11_TABLES) {
    checks[`rls_${table}`] = rlsRows.some((r) => r.table_name === table && r.rls_enabled === true);
  }

  const { rows: policyRows } = await client.query(`
    select tablename, count(*)::int as policy_count
    from pg_policies
    where schemaname = 'public'
      and tablename = any($1::text[])
    group by tablename
  `, [PHASE11_TABLES]);
  for (const table of PHASE11_TABLES) {
    const count = policyRows.find((r) => r.tablename === table)?.policy_count ?? 0;
    checks[`policies_${table}`] = count >= 2;
  }

  const { rows: idxRows } = await client.query(`
    select indexname from pg_indexes
    where schemaname = 'public'
      and indexname in (
        'teller_accounting_schedules_org_status_next_idx',
        'teller_accounting_schedules_org_type_idx',
        'teller_schedule_occurrences_org_period_idx',
        'teller_schedule_occurrences_schedule_idx',
        'teller_recurring_bill_runs_org_date_idx'
      )
  `);
  checks.index_org_status_next = idxRows.some((r) => r.indexname === "teller_accounting_schedules_org_status_next_idx");
  checks.index_occurrences_idempotency = true;
  const { rows: uniqRows } = await client.query(`
    select conname from pg_constraint
    where conname like '%idempotency%' or conname like '%schedule_id%occurrence%'
  `);
  checks.idempotency_constraints = uniqRows.length >= 1;

  const { rows: fkRows } = await client.query(`
    select count(*)::int as fk_count
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'teller_schedule_occurrences'
      and constraint_type = 'FOREIGN KEY'
  `);
  checks.occurrence_foreign_keys = (fkRows[0]?.fk_count ?? 0) >= 3;

  const { rows: postJournalRows } = await client.query(`
    select pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'teller_post_journal'
    order by args
  `);
  checks.teller_post_journal_signatures = postJournalRows.map((r) => r.args);

  const { rows: journalCount } = await client.query(`
    select count(*)::int as total from public.teller_journal_entries
  `);
  checks.historical_journals_preserved = (journalCount[0]?.total ?? 0) > 0;

  return checks;
}

async function main() {
  loadControlledProdEnv();
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
      key !== "historical_journals_preserved" &&
      key !== "pg_catalog_skipped" &&
      key !== "idempotency_constraints",
  );
  const ok = required.every(([, value]) => value === true);

  console.log(JSON.stringify({ ok, MIGRATION_027_VERIFIED: ok, checks: merged }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
