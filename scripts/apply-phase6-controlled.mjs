#!/usr/bin/env node
/**
 * Apply Phase 6 migrations 021 then 022 transactionally on controlled production.
 * Requires: TELLER_CONTROLLED_PROD_TEST=1, SUPABASE_DB_URL in .env.controlled-prod.local
 *
 * Usage: npm run migrate:phase6:controlled
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const MIGRATIONS = ["021_phase6_ap_foundation.sql", "022_phase6_purchasing.sql"];

async function migration021Applied(client) {
  const { rows } = await client.query(`
    select exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teller_parties'
        and column_name = 'payment_terms'
    ) as applied
  `);
  return rows[0]?.applied === true;
}

async function migration022Applied(client) {
  const { rows } = await client.query(`
    select exists (
      select 1 from information_schema.tables
      where table_schema = 'public'
        and table_name = 'teller_purchase_orders'
    ) as applied
  `);
  return rows[0]?.applied === true;
}

async function applyFile(client, file) {
  const sql = readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8");
  console.log(`Applying ${file} …`);
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
    console.log(`  ✓ ${file}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const info = loadControlledProdEnv();
  const projectRef = assertProductionDbUrl(process.env.SUPABASE_DB_URL);

  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL.trim(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const applied = [];
  const skipped = [];

  try {
    if (!(await migration021Applied(client))) {
      await applyFile(client, MIGRATIONS[0]);
      applied.push(MIGRATIONS[0]);
    } else {
      skipped.push(MIGRATIONS[0]);
      console.log(`Skipping ${MIGRATIONS[0]} — already applied`);
    }

    if (!(await migration022Applied(client))) {
      await applyFile(client, MIGRATIONS[1]);
      applied.push(MIGRATIONS[1]);
    } else {
      skipped.push(MIGRATIONS[1]);
      console.log(`Skipping ${MIGRATIONS[1]} — already applied`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          projectRef,
          urlHost: info.urlHost,
          applied,
          skipped,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
