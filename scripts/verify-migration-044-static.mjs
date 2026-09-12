#!/usr/bin/env node
/** Static verification for migration 044 — no DB connection. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];
const migrationPath = join(root, "supabase/migrations/044_phase16d_intercompany.sql");

if (!existsSync(migrationPath)) {
  console.log(JSON.stringify({ MIGRATION_044_STATIC_VERIFY: "FAIL", issues: ["Missing 044 migration"] }, null, 2));
  process.exit(1);
}

const sql = readFileSync(migrationPath, "utf8");

const required = [
  "teller_intercompany_transactions",
  "teller_intercompany_account_pairs",
  "teller_atomic_post_intercompany",
  "teller_atomic_reverse_intercompany",
  "teller_provision_intercompany_accounts",
  "teller_intercompany_pair_balances",
  "teller_ic_tx_entities_distinct",
  "teller_ic_tx_idempotency_uidx",
  "teller_intercompany_tx_immutable",
  "enable row level security",
  "teller_can_access_legal_entity",
  "teller_post_journal",
  "'due_from'",
  "'due_to'",
  "'intercompany'",
  "Intercompany transactions cannot be deleted",
];

for (const token of required) {
  if (!sql.includes(token)) issues.push(`Missing: ${token}`);
}

const forbidden = [
  "teller_consolidation_groups",
  "elimination_entries",
  "create table public.teller_elimination",
];

for (const token of forbidden) {
  if (sql.includes(token)) issues.push(`Forbidden: ${token}`);
}

if (!/owner_legal_entity_id[\s\S]*counterparty_legal_entity_id[\s\S]*unique/i.test(sql)) {
  issues.push("Missing per-entity counterparty account pair uniqueness");
}

console.log(
  JSON.stringify(
    {
      MIGRATION_044_STATIC_VERIFY: issues.length ? "FAIL" : "PASS",
      issues,
      manualMigrationRequired: true,
      migrationFile: "supabase/migrations/044_phase16d_intercompany.sql",
      automaticMigrationApplication: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
