#!/usr/bin/env node
/** Verify migration 030 atomic payroll RPCs on controlled production database. */
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const M030 = resolve(process.cwd(), "supabase/migrations/030_phase12_payroll_atomic_rpc.sql");
const ATOMIC_RPCS = [
  "teller_atomic_post_payroll_run",
  "teller_atomic_reverse_payroll_run",
  "teller_atomic_post_payroll_settlement",
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
      rpc: "teller_atomic_post_payroll_run",
      args: {
        p_organization_id: "00000000-0000-0000-0000-000000000000",
        p_payroll_run_id: "00000000-0000-0000-0000-000000000000",
        p_entry_date: "2099-01-01",
        p_memo: "probe",
        p_lines: [],
        p_actor_id: null,
        p_simulate_failure_after: null,
      },
    },
    {
      rpc: "teller_atomic_reverse_payroll_run",
      args: {
        p_organization_id: "00000000-0000-0000-0000-000000000000",
        p_payroll_run_id: "00000000-0000-0000-0000-000000000000",
        p_reversal_date: "2099-01-01",
        p_memo: "probe",
        p_lines: [],
        p_actor_id: null,
        p_simulate_failure_after: null,
      },
    },
    {
      rpc: "teller_atomic_post_payroll_settlement",
      args: {
        p_organization_id: "00000000-0000-0000-0000-000000000000",
        p_settlement_id: "00000000-0000-0000-0000-000000000000",
        p_entry_date: "2099-01-01",
        p_memo: "probe",
        p_lines: [],
        p_actor_id: null,
        p_simulate_failure_after: null,
      },
    },
  ];

  for (const probe of probes) {
    const { error } = await supabase.rpc(probe.rpc, probe.args);
    checks[`rpc_${probe.rpc}`] = rpcRestCallable(error);
    if (error) checks[`rpc_${probe.rpc}_error`] = error.message;
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
  const { rows } = await client.query(
    `select p.proname
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any($1::text[])`,
    [ATOMIC_RPCS],
  );
  for (const rpc of ATOMIC_RPCS) {
    checks[`pg_${rpc}`] = rows.some((row) => row.proname === rpc);
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
  const migrationSql = readFileSync(M030, "utf8");
  if (/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(migrationSql)) {
    console.log(JSON.stringify({ ok: false, reason: "030 must not replace teller_post_journal" }, null, 2));
    process.exit(1);
  }
  if (/create table/i.test(migrationSql)) {
    console.log(JSON.stringify({ ok: false, reason: "030 must be RPC-only" }, null, 2));
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
        MIGRATION_030_VERIFIED: ok,
        CLAIM_BEFORE_POST_RPC_AVAILABLE: ok,
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
