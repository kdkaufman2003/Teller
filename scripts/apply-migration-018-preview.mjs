#!/usr/bin/env node
/**
 * Apply migration 018 only to the isolated/preview Supabase database.
 * Requires .env.integration with SUPABASE_DB_URL (non-production).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { loadIntegrationEnv } from "./load-integration-env.mjs";

const MIGRATION = "018_phase5_banking_and_reconciliation.sql";

async function main() {
  loadIntegrationEnv({ required: true });

  const dbUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!dbUrl) {
    throw new Error("Missing SUPABASE_DB_URL in .env.integration");
  }

  const sql = readFileSync(resolve(process.cwd(), "supabase/migrations", MIGRATION), "utf8");
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const { rows } = await client.query(
      "select to_regclass('public.teller_bank_matches') as matches_table",
    );
    if (rows[0]?.matches_table) {
      console.log(JSON.stringify({ ok: true, skipped: true, reason: "018 already applied" }, null, 2));
      return;
    }

    console.log(`Applying ${MIGRATION} …`);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    console.log(JSON.stringify({ ok: true, applied: MIGRATION }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
