#!/usr/bin/env node
/**
 * Apply migrations 001–020 to the isolated Supabase database only.
 * Requires .env.integration with SUPABASE_DB_URL and safety opt-in flags.
 *
 * Usage: npm run migrate:integration
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { loadIntegrationEnv } from "./load-integration-env.mjs";

async function main() {
  loadIntegrationEnv({ required: true });

  const dbUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!dbUrl) {
    throw new Error(
      "Missing SUPABASE_DB_URL in .env.integration (Supabase → Settings → Database → connection string).",
    );
  }

  const migrationsDir = resolve(process.cwd(), "supabase/migrations");
  const files = readdirSync(migrationsDir)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort();

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const applied = [];

  try {
    for (const file of files) {
      const sql = readFileSync(resolve(migrationsDir, file), "utf8");
      console.log(`Applying ${file} …`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("COMMIT");
        applied.push(file);
        console.log(`  ✓ ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(
          `${file} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    console.log(JSON.stringify({ ok: true, appliedCount: applied.length, applied }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
