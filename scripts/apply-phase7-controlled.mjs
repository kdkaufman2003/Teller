#!/usr/bin/env node
/**
 * Apply migration 023 transactionally on controlled production.
 * Requires: TELLER_CONTROLLED_PROD_TEST=1, SUPABASE_DB_URL in .env.controlled-prod.local
 *
 * Usage: npm run migrate:phase7:controlled
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const MIGRATION = "023_phase7_job_costing.sql";

async function migration023Applied(client) {
  const { rows } = await client.query(`
    select exists (
      select 1 from information_schema.tables
      where table_schema = 'public'
        and table_name = 'teller_document_sequences'
    ) as applied
  `);
  return rows[0]?.applied === true;
}

async function main() {
  const info = loadControlledProdEnv();
  const projectRef = assertProductionDbUrl(process.env.SUPABASE_DB_URL);

  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL.trim(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    if (await migration023Applied(client)) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            migration: MIGRATION,
            projectRef,
            urlHost: info.urlHost,
            skipped: true,
            reason: "already applied",
          },
          null,
          2,
        ),
      );
      return;
    }

    const sql = readFileSync(resolve(process.cwd(), "supabase/migrations", MIGRATION), "utf8");
    console.log(`Applying ${MIGRATION} …`);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("COMMIT");
      console.log(
        JSON.stringify(
          { ok: true, migration: MIGRATION, projectRef, urlHost: info.urlHost, applied: true },
          null,
          2,
        ),
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
