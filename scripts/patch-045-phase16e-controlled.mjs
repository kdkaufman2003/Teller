#!/usr/bin/env node
/** Hotfix Phase 16E reconciliation RPC + settlement immutability on controlled production. */
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const PATCH = resolve(process.cwd(), "supabase/patches/045_phase16e_reconciliation_immutable_fix.sql");

async function main() {
  loadControlledProdEnv();
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST=1 required");
  }
  const dbUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!dbUrl) {
    throw new Error("SUPABASE_DB_URL required — add to .env.controlled-prod.local, then re-run");
  }
  assertProductionDbUrl(dbUrl);

  const sql = readFileSync(PATCH, "utf8");
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(sql);
    console.log(JSON.stringify({ ok: true, patched: "045_phase16e_reconciliation_immutable_fix.sql" }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
