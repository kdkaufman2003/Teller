#!/usr/bin/env node
/** Verify migration 044 intercompany objects (read-only production probe). */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const M044 = resolve(process.cwd(), "supabase/migrations/044_phase16d_intercompany.sql");

async function main() {
  loadControlledProdEnv();
  const issues = [];

  if (!existsSync(M044)) issues.push("Missing migration file 044");

  const sql = existsSync(M044) ? readFileSync(M044, "utf8") : "";
  const staticChecks = {
    intercompany_transactions: /create table if not exists public\.teller_intercompany_transactions/i.test(sql),
    intercompany_account_pairs: /create table if not exists public\.teller_intercompany_account_pairs/i.test(sql),
    atomic_post: /teller_atomic_post_intercompany/i.test(sql),
    atomic_reverse: /teller_atomic_reverse_intercompany/i.test(sql),
    provision_accounts: /teller_provision_intercompany_accounts/i.test(sql),
  };

  for (const [key, ok] of Object.entries(staticChecks)) {
    if (!ok) issues.push(`044 static missing/failed: ${key}`);
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const checks = {};
  for (const table of ["teller_intercompany_transactions", "teller_intercompany_account_pairs"]) {
    const { error } = await supabase.from(table).select("id").limit(1);
    checks[table] = !error || !/does not exist|schema cache/i.test(error.message);
    if (error && !checks[table]) checks[`${table}_error`] = error.message;
  }

  for (const [rpc, args] of [
    [
      "teller_atomic_post_intercompany",
      {
        p_organization_id: "00000000-0000-0000-0000-000000000000",
        p_source_legal_entity_id: "00000000-0000-0000-0000-000000000000",
        p_counterparty_legal_entity_id: "00000000-0000-0000-0000-000000000001",
        p_transaction_type: "manual",
        p_entry_date: "2026-01-01",
        p_amount: 1,
        p_description: "probe",
        p_reference: null,
        p_source_lines: [],
        p_counterparty_lines: [],
        p_idempotency_key: null,
        p_external_event_id: null,
        p_metadata: {},
        p_actor_id: null,
        p_simulate_failure_after: null,
      },
    ],
    [
      "teller_provision_intercompany_accounts",
      {
        p_organization_id: "00000000-0000-0000-0000-000000000000",
        p_owner_entity_id: "00000000-0000-0000-0000-000000000000",
        p_counterparty_entity_id: "00000000-0000-0000-0000-000000000001",
      },
    ],
    [
      "teller_intercompany_pair_balances",
      {
        p_organization_id: "00000000-0000-0000-0000-000000000000",
        p_entity_a_id: "00000000-0000-0000-0000-000000000000",
        p_entity_b_id: "00000000-0000-0000-0000-000000000001",
        p_as_of: "2026-01-01",
      },
    ],
  ]) {
    const { error } = await supabase.rpc(rpc, args);
    checks[rpc] = !error || !/does not exist|could not find the function/i.test(error.message);
    if (error && !checks[rpc]) checks[`${rpc}_error`] = error.message;
  }

  const staticOk = issues.length === 0;
  const productionOk =
    checks.teller_intercompany_transactions === true &&
    checks.teller_intercompany_account_pairs === true &&
    checks.teller_atomic_post_intercompany === true &&
    checks.teller_provision_intercompany_accounts === true &&
    checks.teller_intercompany_pair_balances === true;

  console.log(
    JSON.stringify(
      {
        MIGRATION_044_STATIC_VERIFY: staticOk ? "PASS" : "FAIL",
        MIGRATION_044_PRODUCTION_VERIFY: productionOk ? "PASS" : "FAIL",
        issues,
        checks,
        migrationFile: "supabase/migrations/044_phase16d_intercompany.sql",
      },
      null,
      2,
    ),
  );

  process.exit(staticOk && productionOk ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
