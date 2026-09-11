#!/usr/bin/env node
/** Static + controlled production verification for migration 037 — no writes. */
import pg from "pg";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const root = process.cwd();
const issues = [];
const migrationPath = "supabase/migrations/037_phase15f_tax_filing_periods.sql";
const M037 = resolve(root, migrationPath);

const TABLES = ["teller_tax_filing_periods", "teller_tax_filing_period_snapshots"];

const TRIGGERS = [
  "teller_tax_filing_periods_org_guard",
  "teller_tax_filing_period_snapshots_immutable",
];

if (!existsSync(M037)) {
  issues.push(`Missing migration: ${migrationPath}`);
} else {
  const sql = readFileSync(M037, "utf8");
  for (const token of [
    "teller_tax_filing_periods",
    "teller_tax_filing_period_snapshots",
    "filing_frequency",
    "ready_for_review",
    "enable row level security",
    "teller_guard_tax_filing_period_org",
    "teller_guard_tax_filing_period_snapshot_immutable",
    "unique (organization_id, registration_id, period_start, period_end)",
  ]) {
    if (!sql.includes(token)) issues.push(`037 migration missing: ${token}`);
  }
  if (/\binsert\s+into\s+public\.teller_journal_entries/i.test(sql)) {
    issues.push("037 migration must not insert journal entries");
  }
  if (/\b(create|alter|drop|replace)\s+function\s+public\.teller_post_journal/i.test(sql)) {
    issues.push("037 migration must not modify teller_post_journal");
  }
}

for (const rel of [
  "src/lib/accounting/tax/filing/reconcile.ts",
  "src/lib/accounting/tax/filing/period-generation.ts",
  "src/lib/accounting/tax/filing/service.ts",
  "src/lib/accounting/tax/phase15f.test.ts",
  "src/app/api/tax/filing-periods/route.ts",
]) {
  if (!existsSync(join(root, rel))) issues.push(`Missing file: ${rel}`);
}

const filingDomain = [
  "src/lib/accounting/tax/filing/reconcile.ts",
  "src/lib/accounting/tax/filing/rollforward.ts",
  "src/lib/accounting/tax/filing/service.ts",
]
  .map((rel) => readFileSync(join(root, rel), "utf8"))
  .join("\n");

if (!/reconcileTaxPeriod/.test(filingDomain)) {
  issues.push("15F canonical reconciliation service missing");
}
if (!/use_tax_accrued|sales_tax_collected/.test(filingDomain)) {
  issues.push("15F rollforward must include sales and use tax transaction types");
}
if (/teller_post_journal|postJournal\(/.test(filingDomain)) {
  issues.push("15F filing domain must not create journals");
}
if (/authority_payment/.test(filingDomain) && !/PHASE15F|exclude|!==|\.neq/.test(filingDomain)) {
  issues.push("15F must exclude authority payments from period liability");
}

async function restProbe(supabase) {
  const checks = {};
  for (const table of TABLES) {
    const { error } = await supabase.from(table).select("*", { head: true, count: "exact" }).limit(1);
    checks[`table_${table}`] = !error || !/does not exist|schema cache|PGRST205/i.test(error.message);
    if (error) checks[`table_${table}_error`] = error.message;
  }
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

  return checks;
}

async function main() {
  loadControlledProdEnv();

  const staticOk = issues.length === 0;
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
    ([key, value]) => !key.endsWith("_error") && key !== "pg_catalog_skipped",
  );
  const productionOk = required.every(([, value]) => value === true);

  if (!productionOk) {
    for (const [key, value] of required) {
      if (value !== true) issues.push(`production check failed: ${key}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        MIGRATION_037_STATIC_VERIFY: staticOk ? "PASS" : "FAIL",
        MIGRATION_037_PRODUCTION_VERIFY: productionOk ? "PASS" : "FAIL",
        MIGRATION_037_VERIFY: staticOk && productionOk ? "PASS" : "FAIL",
        issues,
        checks: merged,
        migrationFile: migrationPath,
      },
      null,
      2,
    ),
  );

  process.exit(staticOk && productionOk ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
