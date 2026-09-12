#!/usr/bin/env node
/** Static verification for migration 047 — no DB connection. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];
const migrationPath = join(root, "supabase/migrations/047_phase16h_entity_controls.sql");

if (!existsSync(migrationPath)) {
  console.log(JSON.stringify({ MIGRATION_047_STATIC_VERIFY: "FAIL", issues: ["Missing 047 migration"] }, null, 2));
  process.exit(1);
}

const sql = readFileSync(migrationPath, "utf8");

const required = [
  "teller_can_access_legal_entity",
  "teller_can_write_books",
  "teller_is_org_member",
  "teller entity accounts select",
  "teller entity documents select",
  "teller entity journal entries select",
  "teller entity payments select",
  "teller entity bank accounts select",
  "teller_phase16h_controls_applied",
  "legal_entity_id",
];

for (const token of required) {
  if (!sql.includes(token)) issues.push(`Missing: ${token}`);
}

if (/disable row level security/i.test(sql)) issues.push("Must not disable RLS");

console.log(
  JSON.stringify(
    {
      MIGRATION_047_STATIC_VERIFY: issues.length ? "FAIL" : "PASS",
      ENTITY_RLS_POLICY_AUDIT: issues.length ? "FAIL" : "PASS_DESIGN",
      issues,
      manualMigrationRequired: true,
      migrationFile: "supabase/migrations/047_phase16h_entity_controls.sql",
      automaticMigrationApplication: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
