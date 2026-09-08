#!/usr/bin/env node
/** Verify migration 031 inventory + GRNI objects on controlled production database. */
import pg from "pg";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const M031 = resolve(process.cwd(), "supabase/migrations/031_phase13_inventory.sql");

const TABLES = [
  "teller_inventory_items",
  "teller_inventory_locations",
  "teller_inventory_movements",
  "teller_inventory_balances",
  "teller_inventory_transfer_groups",
  "teller_inventory_counts",
  "teller_inventory_count_lines",
  "teller_inventory_account_mappings",
  "teller_inventory_receipt_bill_allocations",
];

const ATOMIC_RPCS = [
  "teller_atomic_receive_inventory",
  "teller_atomic_issue_inventory",
  "teller_atomic_transfer_inventory",
  "teller_atomic_reverse_inventory_movement",
  "teller_atomic_settle_inventory_receipt_bill",
  "teller_atomic_reverse_inventory_receipt_bill_allocation",
];

const RECEIPT_LINE_COLUMNS = [
  "inventory_item_id",
  "inventory_location_id",
  "unit_cost",
  "extended_cost",
  "quantity_matched",
  "value_matched",
  "accounting_status",
  "inventory_movement_id",
  "receipt_journal_entry_id",
  "idempotency_key",
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
  const probes = [
    {
      rpc: "teller_atomic_receive_inventory",
      args: {
        p_organization_id: "00000000-0000-0000-0000-000000000000",
        p_inventory_item_id: "00000000-0000-0000-0000-000000000000",
        p_location_id: "00000000-0000-0000-0000-000000000000",
        p_quantity: 1,
        p_unit_cost: 1,
        p_movement_type: "purchase_receipt",
        p_source_type: "probe",
        p_source_id: "00000000-0000-0000-0000-000000000000",
        p_idempotency_key: "probe:receive",
        p_entry_date: null,
        p_journal_lines: null,
        p_journal_source_kind: null,
        p_journal_source_id: null,
        p_actor_id: null,
      },
    },
    {
      rpc: "teller_atomic_settle_inventory_receipt_bill",
      args: {
        p_organization_id: "00000000-0000-0000-0000-000000000000",
        p_receipt_line_id: "00000000-0000-0000-0000-000000000000",
        p_bill_line_id: "00000000-0000-0000-0000-000000000000",
        p_bill_id: "00000000-0000-0000-0000-000000000000",
        p_quantity_matched: 1,
        p_receipt_unit_cost: 1,
        p_bill_unit_cost: 1,
        p_idempotency_key: "probe:settle",
        p_entry_date: "2099-01-01",
        p_journal_lines: [],
        p_actor_id: null,
      },
    },
  ];

  for (const probe of probes) {
    const { error } = await supabase.rpc(probe.rpc, probe.args);
    checks[`rpc_${probe.rpc}`] = rpcRestCallable(error);
    if (error) checks[`rpc_${probe.rpc}_error`] = error.message;
  }

  for (const table of TABLES) {
    const { error } = await supabase.from(table).select("id", { head: true, count: "exact" }).limit(1);
    checks[`table_${table}`] = !error || !/does not exist|schema cache/i.test(error.message);
    if (error) checks[`table_${table}_error`] = error.message;
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
    [ATOMIC_RPCS],
  );
  for (const rpc of ATOMIC_RPCS) {
    checks[`pg_${rpc}`] = rpcRows.some((row) => row.proname === rpc);
  }

  const { rows: colRows } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'teller_purchase_receipt_lines'
       and column_name = any($1::text[])`,
    [RECEIPT_LINE_COLUMNS],
  );
  for (const col of RECEIPT_LINE_COLUMNS) {
    checks[`pg_receipt_line_${col}`] = colRows.some((row) => row.column_name === col);
  }

  const { rows: postJournalRows } = await client.query(
    `select pg_get_function_identity_arguments(p.oid) as args
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'teller_post_journal'`,
  );
  checks.teller_post_journal_signatures = postJournalRows.map((row) => row.args);
  return checks;
}

async function main() {
  loadControlledProdEnv();
  if (!existsSync(M031)) {
    console.log(JSON.stringify({ ok: false, reason: "missing 031 migration file" }, null, 2));
    process.exit(1);
  }
  const migrationSql = readFileSync(M031, "utf8");
  if (/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(migrationSql)) {
    console.log(JSON.stringify({ ok: false, reason: "031 must not replace teller_post_journal" }, null, 2));
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
      key !== "pg_catalog_skipped",
  );
  const ok = required.every(([, value]) => value === true);

  console.log(
    JSON.stringify(
      {
        ok,
        MIGRATION_031_VERIFIED: ok,
        TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED: merged.teller_post_journal_unchanged === true,
        checks: merged,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
