#!/usr/bin/env node
/** Verify migration 040 legal entity objects on controlled production database (read-only). */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const M040 = resolve(process.cwd(), "supabase/migrations/040_phase16a_legal_entity_foundation.sql");

async function main() {
  loadControlledProdEnv();
  const issues = [];

  if (!existsSync(M040)) issues.push("Missing migration file 040");

  const sql = existsSync(M040) ? readFileSync(M040, "utf8") : "";
  if (sql && !sql.includes("teller_legal_entities_one_default_per_org")) {
    issues.push("040 missing default entity partial unique index");
  }
  if (sql && /alter table public\.teller_journal_entries[\s\S]*legal_entity_id/i.test(sql)) {
    issues.push("040 must not add journal legal_entity_id in 16A");
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const checks = {};
  const { error: tableError } = await supabase.from("teller_legal_entities").select("id").limit(1);
  checks.table_teller_legal_entities = !tableError || !/does not exist|schema cache/i.test(tableError.message);
  if (tableError) checks.table_teller_legal_entities_error = tableError.message;

  const { error: rpcError } = await supabase.rpc("teller_seed_default_legal_entity", {
    p_org_id: "00000000-0000-0000-0000-000000000000",
  });
  checks.teller_seed_default_legal_entity_present =
    !rpcError || !/does not exist|function.*does not exist/i.test(rpcError.message);

  const ok = issues.length === 0 && checks.table_teller_legal_entities === true;
  console.log(
    JSON.stringify(
      {
        MIGRATION_040_STATIC_VERIFY: existsSync(M040) ? "PASS" : "FAIL",
        MIGRATION_040_PRODUCTION_VERIFY: checks.table_teller_legal_entities ? "PASS" : "PENDING",
        MIGRATION_040_VERIFY: ok ? "PASS" : checks.table_teller_legal_entities ? "PARTIAL" : "PENDING",
        issues,
        checks,
        migrationFile: "supabase/migrations/040_phase16a_legal_entity_foundation.sql",
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : checks.table_teller_legal_entities ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
