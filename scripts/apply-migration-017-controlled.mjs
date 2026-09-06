#!/usr/bin/env node
/** Apply migration 017 only, transactionally, on controlled production database. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

async function main() {
  const info = loadControlledProdEnv();
  const dbUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!dbUrl) {
    throw new Error(
      "Missing SUPABASE_DB_URL in .env.controlled-prod.local — required to apply migration 017.",
    );
  }

  const sql = readFileSync(
    resolve(process.cwd(), "supabase/migrations/017_phase4_settlements_and_coa.sql"),
    "utf8",
  );

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    console.log("Applying migration 017 in transaction …");
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log(JSON.stringify({ ok: true, migration: "017_phase4_settlements_and_coa.sql", ...info }, null, 2));
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
