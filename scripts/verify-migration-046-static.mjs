#!/usr/bin/env node
/** Static verification for migration 046 — no DB connection. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];
const migrationPath = join(root, "supabase/migrations/046_phase16g_consolidation_eliminations.sql");

if (!existsSync(migrationPath)) {
  console.log(JSON.stringify({ MIGRATION_046_STATIC_VERIFY: "FAIL", issues: ["Missing 046 migration"] }, null, 2));
  process.exit(1);
}

const sql = readFileSync(migrationPath, "utf8");

const required = [
  "teller_consolidation_elimination_entries",
  "teller_consolidation_elimination_lines",
  "teller_consolidation_elimination_sources",
  "teller_consolidation_report_locks",
  "teller_consolidation_scope_key",
  "teller_consolidation_scope_entities_accessible",
  "teller_atomic_post_consolidation_elimination",
  "teller_atomic_reverse_consolidation_elimination",
  "teller_consolidation_elimination_immutable",
  "Consolidation eliminations cannot be deleted",
  "Posted consolidation elimination cannot be modified",
  "Consolidation elimination entry is not balanced",
  "enable row level security",
  "teller_can_access_legal_entity",
  "teller_has_restricted_entity_access",
  "teller_is_org_member",
  "teller_can_write_books",
  "due_to_due_from",
  "intercompany_pl",
  "idempotency_key",
];

for (const token of required) {
  if (!sql.includes(token)) issues.push(`Missing: ${token}`);
}

const forbidden = [
  "teller_post_journal",
  "insert into public.teller_journal",
  "teller_tax_transactions",
  "teller_invoices",
  "teller_bills",
];

for (const token of forbidden) {
  if (sql.includes(token)) issues.push(`Forbidden (entity-book mutation): ${token}`);
}

console.log(
  JSON.stringify(
    {
      MIGRATION_046_STATIC_VERIFY: issues.length ? "FAIL" : "PASS",
      ELIMINATIONS_POST_TO_LEGAL_ENTITY_JOURNALS: false,
      ELIMINATION_GENERATES_SALES_TAX: false,
      issues,
      manualMigrationRequired: true,
      migrationFile: "supabase/migrations/046_phase16g_consolidation_eliminations.sql",
      automaticMigrationApplication: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
