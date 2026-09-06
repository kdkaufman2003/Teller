#!/usr/bin/env node
/** Apply migration 018 only, transactionally, on controlled production database. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const MIGRATION_FILE = "018_phase5_banking_and_reconciliation.sql";

async function alreadyApplied(client) {
  const { rows } = await client.query(
    "select to_regclass('public.teller_bank_matches') as table_ref",
  );
  return Boolean(rows[0]?.table_ref);
}

async function main() {
  const info = loadControlledProdEnv();
  const projectRef = assertProductionDbUrl(process.env.SUPABASE_DB_URL);

  const sql = readFileSync(resolve(process.cwd(), "supabase/migrations", MIGRATION_FILE), "utf8");
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL.trim(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    if (await alreadyApplied(client)) {
      console.log(JSON.stringify({ ok: true, skipped: true, migration: MIGRATION_FILE }, null, 2));
      return;
    }

    console.log("Applying migration 018 in transaction …");
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log(
      JSON.stringify(
        { ok: true, migration: MIGRATION_FILE, projectRef, urlHost: info.urlHost },
        null,
        2,
      ),
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
