#!/usr/bin/env node
/** Verify migration 028 applied on controlled production database. */
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const PHASE11_1_TABLES = [
  "teller_accrual_settlements",
  "teller_accrual_settlement_allocations",
  "teller_scheduler_runs",
];

const ALLOCATION_COLUMNS = [
  "actual_amount_allocated",
  "actual_pre_tax_allocated",
  "nonrecoverable_tax_allocated",
  "recoverable_tax_allocated",
];

const SETTLEMENT_COLUMNS = [
  "accrual_settlement_portion",
  "new_expense_portion",
  "purchase_tax_portion",
  "idempotency_key",
];

async function restProbe(supabase) {
  const checks = {};
  for (const table of PHASE11_1_TABLES) {
    const { error } = await supabase.from(table).select("id").limit(0);
    checks[`table_${table}`] = !error;
    if (error) checks[`table_${table}_error`] = error.message;
  }

  const { error: allocError } = await supabase
    .from("teller_accrual_settlement_allocations")
    .select(ALLOCATION_COLUMNS.join(", "))
    .limit(0);
  checks.allocation_tax_columns = !allocError;
  if (allocError) checks.allocation_tax_columns_error = allocError.message;

  const { error: settlementError } = await supabase
    .from("teller_accrual_settlements")
    .select(SETTLEMENT_COLUMNS.join(", "))
    .limit(0);
  checks.settlement_portion_columns = !settlementError;
  if (settlementError) checks.settlement_portion_columns_error = settlementError.message;

  const { error: postError } = await supabase.rpc("teller_post_journal", {
    p_org: "00000000-0000-0000-0000-000000000000",
    p_entry_date: "2099-01-01",
    p_memo: "probe",
    p_lines: [],
    p_source: "probe",
    p_idempotency_key: "probe-028",
  });
  checks.teller_post_journal_exists = Boolean(postError && !/function.*does not exist/i.test(postError.message));

  return checks;
}

async function pgDeepChecks(client) {
  const checks = {};

  const { rows: tableRows } = await client.query(
    `
    select tablename from pg_tables
    where schemaname = 'public'
      and tablename = any($1::text[])
  `,
    [PHASE11_1_TABLES],
  );
  for (const table of PHASE11_1_TABLES) {
    checks[`pg_table_${table}`] = tableRows.some((r) => r.tablename === table);
  }

  const { rows: rlsRows } = await client.query(
    `
    select c.relname as table_name, c.relrowsecurity as rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any($1::text[])
  `,
    [PHASE11_1_TABLES],
  );
  for (const table of PHASE11_1_TABLES) {
    checks[`rls_${table}`] = rlsRows.some((r) => r.table_name === table && r.rls_enabled === true);
  }

  const { rows: policyRows } = await client.query(
    `
    select tablename, count(*)::int as policy_count
    from pg_policies
    where schemaname = 'public'
      and tablename = any($1::text[])
    group by tablename
  `,
    [PHASE11_1_TABLES],
  );
  for (const table of PHASE11_1_TABLES) {
    const count = policyRows.find((r) => r.tablename === table)?.policy_count ?? 0;
    checks[`policies_${table}`] = count >= 1;
  }

  for (const column of ALLOCATION_COLUMNS) {
    const { rows } = await client.query(
      `
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teller_accrual_settlement_allocations'
        and column_name = $1
    `,
      [column],
    );
    checks[`column_alloc_${column}`] = rows.length > 0;
  }

  for (const column of SETTLEMENT_COLUMNS) {
    const { rows } = await client.query(
      `
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teller_accrual_settlements'
        and column_name = $1
    `,
      [column],
    );
    checks[`column_settlement_${column}`] = rows.length > 0;
  }

  const { rows: triggerRows } = await client.query(`
    select tgname from pg_trigger
    where tgname = 'teller_accrual_allocation_capacity_trg'
  `);
  checks.over_settlement_trigger = triggerRows.length > 0;

  const { rows: functionRows } = await client.query(`
    select proname from pg_proc
    where proname = 'teller_accrual_allocation_capacity_check'
  `);
  checks.over_settlement_function = functionRows.length > 0;

  const { rows: uniqRows } = await client.query(`
    select conname from pg_constraint
    where conrelid = 'public.teller_accrual_settlements'::regclass
      and contype = 'u'
  `);
  checks.settlement_unique_constraints = uniqRows.length >= 2;

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

  const { rows: alterPostJournal } = await client.query(`
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'teller_post_journal'
      and pg_get_functiondef(p.oid) ilike '%028%'
  `);
  checks.teller_post_journal_body_unchanged_by_028 = alterPostJournal.length === 0;

  return checks;
}

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

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
  const skipKeys = new Set([
    "teller_post_journal_signatures",
    "historical_journals_preserved",
    "pg_catalog_skipped",
    "teller_post_journal_body_unchanged_by_028",
  ]);
  const required = Object.entries(merged).filter(
    ([key, value]) => !key.endsWith("_error") && !skipKeys.has(key),
  );
  const ok = required.every(([, value]) => value === true);

  console.log(JSON.stringify({ ok, MIGRATION_028_VERIFIED: ok, checks: merged }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
