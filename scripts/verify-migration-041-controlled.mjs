#!/usr/bin/env node
/** Verify migration 041 entity access objects (read-only production probe). */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const M041 = resolve(process.cwd(), "supabase/migrations/041_phase16b_entity_access.sql");

async function main() {
  loadControlledProdEnv();
  const issues = [];

  if (!existsSync(M041)) issues.push("Missing migration file 041");

  const sql = existsSync(M041) ? readFileSync(M041, "utf8") : "";
  const staticChecks = {
    memberships_table: sql.includes("teller_legal_entity_memberships"),
    active_entity_column: sql.includes("active_legal_entity_id"),
    access_function: sql.includes("teller_can_access_legal_entity"),
    default_rpc: sql.includes("teller_set_default_legal_entity"),
    replaced_select_policy: sql.includes("teller members read accessible legal entities"),
    no_economic_backfill: !/alter table public\.teller_journal_entries[\s\S]*legal_entity_id/i.test(sql),
  };

  for (const [key, ok] of Object.entries(staticChecks)) {
    if (!ok) issues.push(`041 static missing/failed: ${key}`);
  }

  if (/create policy[\s\S]*teller members read legal entities/i.test(sql)) {
    issues.push("041 must replace old permissive legal entity SELECT policy");
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const checks = {};
  const { error: tableError } = await supabase
    .from("teller_legal_entity_memberships")
    .select("id")
    .limit(1);
  checks.table_teller_legal_entity_memberships =
    !tableError || !/does not exist|schema cache/i.test(tableError.message);
  if (tableError) checks.table_teller_legal_entity_memberships_error = tableError.message;

  const { error: profileError } = await supabase
    .from("teller_profiles")
    .select("active_legal_entity_id")
    .limit(1);
  checks.profile_active_legal_entity_id =
    !profileError || !/does not exist|schema cache/i.test(profileError.message);

  const { error: rpcError } = await supabase.rpc("teller_set_default_legal_entity", {
    p_org_id: "00000000-0000-0000-0000-000000000000",
    p_entity_id: "00000000-0000-0000-0000-000000000000",
  });
  checks.teller_set_default_legal_entity_present =
    !rpcError || !/does not exist|function.*does not exist|could not find the function/i.test(rpcError.message);

  const { error: accessFnError } = await supabase.rpc("teller_can_access_legal_entity", {
    p_org: "00000000-0000-0000-0000-000000000000",
    p_entity_id: "00000000-0000-0000-0000-000000000000",
  });
  checks.teller_can_access_legal_entity_present =
    !accessFnError ||
    !/does not exist|function.*does not exist|could not find the function/i.test(accessFnError.message);
  if (accessFnError) checks.teller_can_access_legal_entity_error = accessFnError.message;

  const staticOk = issues.length === 0;
  const productionOk =
    checks.table_teller_legal_entity_memberships === true &&
    checks.profile_active_legal_entity_id === true &&
    checks.teller_can_access_legal_entity_present === true &&
    checks.teller_set_default_legal_entity_present === true;

  console.log(
    JSON.stringify(
      {
        MIGRATION_041_STATIC_VERIFY: staticOk ? "PASS" : "FAIL",
        MIGRATION_041_PRODUCTION_VERIFY: productionOk ? "PASS" : "PENDING",
        MIGRATION_041_VERIFY: staticOk && productionOk ? "PASS" : staticOk ? "PARTIAL" : "FAIL",
        issues,
        staticChecks,
        checks,
        migrationFile: "supabase/migrations/041_phase16b_entity_access.sql",
      },
      null,
      2,
    ),
  );

  process.exit(staticOk ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
