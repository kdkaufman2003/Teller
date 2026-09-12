#!/usr/bin/env node
/** Verify migration 042 entity books objects (read-only production probe). */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const M042 = resolve(process.cwd(), "supabase/migrations/042_phase16c_entity_books.sql");

async function main() {
  loadControlledProdEnv();
  const issues = [];

  if (!existsSync(M042)) issues.push("Missing migration file 042");

  const sql = existsSync(M042) ? readFileSync(M042, "utf8") : "";
  const staticChecks = {
    accounts_legal_entity_id: /alter table public\.teller_accounts[\s\S]*legal_entity_id/i.test(sql),
    journals_legal_entity_id: /alter table public\.teller_journal_entries[\s\S]*legal_entity_id/i.test(sql),
    post_journal_entity_param: /p_legal_entity_id uuid/i.test(sql),
    cross_entity_guard: /teller_assert_accounts_match_entity/i.test(sql),
  };

  for (const [key, ok] of Object.entries(staticChecks)) {
    if (!ok) issues.push(`042 static missing/failed: ${key}`);
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const checks = {};
  for (const [table, col] of [
    ["teller_accounts", "legal_entity_id"],
    ["teller_journal_entries", "legal_entity_id"],
    ["teller_documents", "legal_entity_id"],
    ["teller_payments", "legal_entity_id"],
    ["teller_bank_accounts", "legal_entity_id"],
    ["teller_period_closes", "legal_entity_id"],
    ["teller_entity_accounting_settings", "legal_entity_id"],
  ]) {
    const { error } = await supabase.from(table).select(col).limit(1);
    checks[`${table}.${col}`] = !error || !/does not exist|schema cache/i.test(error.message);
    if (error && !checks[`${table}.${col}`]) checks[`${table}_error`] = error.message;
  }

  const { error: rpcError } = await supabase.rpc("teller_post_journal", {
    p_organization_id: "00000000-0000-0000-0000-000000000000",
    p_legal_entity_id: "00000000-0000-0000-0000-000000000000",
    p_entry_date: "2026-01-01",
    p_memo: "",
    p_source_kind: "manual",
    p_source_id: null,
    p_reverses_entry_id: null,
    p_lines: [],
  });
  checks.teller_post_journal_8_param =
    !rpcError || !/does not exist|could not find the function/i.test(rpcError.message);

  const { error: defaultFnError } = await supabase.rpc("teller_default_legal_entity_id", {
    p_org_id: "00000000-0000-0000-0000-000000000000",
  });
  checks.teller_default_legal_entity_id_present =
    !defaultFnError ||
    !/does not exist|could not find the function/i.test(defaultFnError.message);

  const staticOk = issues.length === 0;
  const productionOk =
    checks["teller_accounts.legal_entity_id"] === true &&
    checks["teller_journal_entries.legal_entity_id"] === true &&
    checks.teller_post_journal_8_param === true &&
    checks.teller_default_legal_entity_id_present === true;

  console.log(
    JSON.stringify(
      {
        MIGRATION_042_STATIC_VERIFY: staticOk ? "PASS" : "FAIL",
        MIGRATION_042_PRODUCTION_VERIFY: productionOk ? "PASS" : "FAIL",
        MIGRATION_042_VERIFY: staticOk && productionOk ? "PASS" : "FAIL",
        staticChecks,
        checks,
        issues,
        migrationFile: "supabase/migrations/042_phase16c_entity_books.sql",
      },
      null,
      2,
    ),
  );
  process.exit(staticOk && productionOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
