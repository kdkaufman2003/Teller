#!/usr/bin/env node
/** Apply migration 044 intercompany to controlled production (manual gate). */
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertProductionDbUrl } from "./controlled-prod-db-url.mjs";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const M044 = resolve(process.cwd(), "supabase/migrations/044_phase16d_intercompany.sql");

async function main() {
  loadControlledProdEnv();
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST=1 required");
  }
  const dbUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!dbUrl) throw new Error("SUPABASE_DB_URL required to apply migration 044");
  assertProductionDbUrl(dbUrl);

  const sql = readFileSync(M044, "utf8");
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(sql);
    await client.query("notify pgrst, 'reload schema'");
    console.log(JSON.stringify({ ok: true, applied: "044_phase16d_intercompany.sql" }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
