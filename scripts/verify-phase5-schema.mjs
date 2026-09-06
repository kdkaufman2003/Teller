#!/usr/bin/env node
/**
 * Verify Phase 5A schema on isolated/preview Supabase.
 * Usage: npm run verify:phase5-schema
 */
import { createClient } from "@supabase/supabase-js";
import { loadIntegrationEnv } from "./load-integration-env.mjs";

const PHASE5_TABLES = [
  "teller_bank_matches",
  "teller_bank_transaction_splits",
  "teller_bank_transfers",
  "teller_bank_reconciliations",
  "teller_bank_reconciliation_items",
  "teller_bank_import_batches",
];

const PHASE5_COLUMNS = [
  ["teller_bank_transactions", "normalized_amount"],
  ["teller_bank_transactions", "status"],
  ["teller_bank_transactions", "provider_pending_transaction_id"],
  ["teller_bank_transactions", "provider_lifecycle_state"],
  ["teller_bank_accounts", "gl_account_id"],
  ["teller_bank_connections", "last_successful_sync_at"],
];

async function main() {
  loadIntegrationEnv({ required: true });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const checks = [];

  for (const table of PHASE5_TABLES) {
    const { error } = await supabase.from(table).select("id", { count: "exact", head: true });
    checks.push({
      name: `${table} exists`,
      pass: !error,
      detail: error?.message ?? "ok",
    });
  }

  for (const [table, column] of PHASE5_COLUMNS) {
    const { error } = await supabase.from(table).select(column).limit(0);
    checks.push({
      name: `${table}.${column}`,
      pass: !error,
      detail: error?.message ?? "ok",
    });
  }

  const { error: legacyReadError } = await supabase
    .from("teller_bank_transactions")
    .select("id, match_status, amount, normalized_amount, status")
    .limit(1);
  checks.push({
    name: "legacy bank transactions readable",
    pass: !legacyReadError,
    detail: legacyReadError?.message ?? "ok",
  });

  const allPass = checks.every((check) => check.pass);
  console.log(
    JSON.stringify(
      {
        allPass,
        projectRef: new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0],
        checks,
      },
      null,
      2,
    ),
  );
  if (!allPass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
