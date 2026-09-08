#!/usr/bin/env node
/** Static Phase 14A verification — no DB writes. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];

const migrationPath = join(root, "supabase/migrations/032_phase14_planning.sql");
if (!existsSync(migrationPath)) {
  issues.push("Missing migration 032_phase14_planning.sql");
} else {
  const sql = readFileSync(migrationPath, "utf8");
  const required = [
    "teller_planning_settings",
    "teller_budgets",
    "teller_budget_versions",
    "teller_budget_lines",
    "teller_planning_audit_events",
    "enable row level security",
    "teller_guard_budget_line_editable",
    "teller_atomic_clone_budget_version",
  ];
  for (const token of required) {
    if (!sql.includes(token)) issues.push(`Migration missing: ${token}`);
  }
  if (/teller_post_journal/i.test(sql)) {
    const modifiesJournal = /\b(create|alter|drop|replace)\b[\s\S]*teller_post_journal/i.test(sql);
    if (modifiesJournal) issues.push("Migration must not modify teller_post_journal");
  }
}

const requiredFiles = [
  "src/lib/planning/budgets/budget-crud.ts",
  "src/lib/planning/budgets/lifecycle.ts",
  "src/lib/planning/budgets/phase14.test.ts",
  "src/app/api/planning/budgets/route.ts",
  "src/components/planning/BudgetEditor.tsx",
];

for (const rel of requiredFiles) {
  if (!existsSync(join(root, rel))) issues.push(`Missing file: ${rel}`);
}

const crud = readFileSync(join(root, "src/lib/planning/budgets/budget-crud.ts"), "utf8");
if (/teller_post_journal/i.test(crud)) {
  issues.push("Planning code must not call teller_post_journal");
}

console.log(
  JSON.stringify(
    {
      PHASE14_PLANNING_VERIFY: issues.length ? "FAIL" : "PASS",
      issues,
      manualMigrationRequired: true,
      migrationFile: "supabase/migrations/032_phase14_planning.sql",
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
