#!/usr/bin/env node
/** Static verification for migration 045 — no DB connection. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];
const migrationPath = join(root, "supabase/migrations/045_phase16e_intercompany_settlement.sql");

if (!existsSync(migrationPath)) {
  console.log(JSON.stringify({ MIGRATION_045_STATIC_VERIFY: "FAIL", issues: ["Missing 045 migration"] }, null, 2));
  process.exit(1);
}

const sql = readFileSync(migrationPath, "utf8");

const required = [
  "teller_intercompany_settlements",
  "teller_intercompany_settlement_allocations",
  "teller_atomic_post_intercompany_settlement",
  "teller_atomic_reverse_intercompany_settlement",
  "teller_intercompany_tx_open_balance",
  "teller_intercompany_open_items",
  "teller_intercompany_pair_reconciliation",
  "teller_resolve_entity_cash_account",
  "teller_ic_settlement_idempotency_uidx",
  "teller_intercompany_settlement_immutable",
  "enable row level security",
  "teller_can_access_legal_entity",
  "teller_post_journal",
  "'intercompany-settlement'",
  "Intercompany settlements cannot be deleted",
  "Allocation over-applies intercompany transaction",
  "intercompany_settlement",
];

for (const token of required) {
  if (!sql.includes(token)) issues.push(`Missing: ${token}`);
}

const forbidden = [
  "teller_consolidation_groups",
  "elimination_entries",
  "create table public.teller_elimination",
  "teller_tax_transactions",
];

for (const token of forbidden) {
  if (sql.includes(token)) issues.push(`Forbidden: ${token}`);
}

console.log(
  JSON.stringify(
    {
      MIGRATION_045_STATIC_VERIFY: issues.length ? "FAIL" : "PASS",
      issues,
      manualMigrationRequired: true,
      migrationFile: "supabase/migrations/045_phase16e_intercompany_settlement.sql",
      automaticMigrationApplication: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
