#!/usr/bin/env node
/** Verify migration 026 applied on controlled production database. */
import pg from "pg";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

async function main() {
  loadControlledProdEnv();
  assertProductionDbUrl(process.env.SUPABASE_DB_URL);
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL.trim(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const checks = {};
    const { rows: rpcRows } = await client.query(`
      select exists (
        select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'teller_gl_account_totals'
      ) as exists
    `);
    checks.rpc_teller_gl_account_totals = rpcRows[0]?.exists === true;

    const { rows: colRows } = await client.query(`
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'teller_accounts'
          and column_name = 'cash_flow_category'
      ) as exists
    `);
    checks.cash_flow_category_column = colRows[0]?.exists === true;

    const { rows: tableRows } = await client.query(`
      select tablename
      from pg_tables
      where schemaname = 'public'
        and tablename in ('teller_report_line_groups', 'teller_account_report_mappings')
    `);
    checks.report_line_groups = tableRows.some((r) => r.tablename === "teller_report_line_groups");
    checks.account_report_mappings = tableRows.some(
      (r) => r.tablename === "teller_account_report_mappings",
    );

    const { rows: rlsRows } = await client.query(`
      select c.relname as table_name, c.relrowsecurity as rls_enabled
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('teller_report_line_groups', 'teller_account_report_mappings')
    `);
    checks.report_line_groups_rls = rlsRows.some(
      (r) => r.table_name === "teller_report_line_groups" && r.rls_enabled === true,
    );
    checks.account_report_mappings_rls = rlsRows.some(
      (r) => r.table_name === "teller_account_report_mappings" && r.rls_enabled === true,
    );

    const { rows: policyRows } = await client.query(`
      select tablename, policyname
      from pg_policies
      where schemaname = 'public'
        and tablename in ('teller_report_line_groups', 'teller_account_report_mappings')
    `);
    checks.report_line_groups_policies = policyRows.filter(
      (r) => r.tablename === "teller_report_line_groups",
    ).length;
    checks.account_report_mappings_policies = policyRows.filter(
      (r) => r.tablename === "teller_account_report_mappings",
    ).length;
    checks.report_line_groups_tenant_policies =
      checks.report_line_groups_policies >= 2 &&
      policyRows.some(
        (r) =>
          r.tablename === "teller_report_line_groups" &&
          /teller members read report line groups/i.test(r.policyname),
      );
    checks.account_report_mappings_tenant_policies =
      checks.account_report_mappings_policies >= 2 &&
      policyRows.some(
        (r) =>
          r.tablename === "teller_account_report_mappings" &&
          /teller members read account report mappings/i.test(r.policyname),
      );

    const { rows: postJournalRows } = await client.query(`
      select pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'teller_post_journal'
      order by args
    `);
    checks.teller_post_journal_signatures = postJournalRows.map((r) => r.args);

    const ok = Object.entries(checks)
      .filter(([key]) => !key.startsWith("teller_post_journal") && !key.endsWith("_policies"))
      .every(([, value]) => value === true);

    console.log(JSON.stringify({ ok, checks }, null, 2));
    process.exit(ok ? 0 : 1);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
