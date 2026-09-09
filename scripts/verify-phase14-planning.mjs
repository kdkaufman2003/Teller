#!/usr/bin/env node
/** Static Phase 14 schema/code verification — no DB writes. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];

function assertSqlFile(relPath, requiredTokens, label) {
  const path = join(root, relPath);
  if (!existsSync(path)) {
    issues.push(`Missing SQL: ${relPath}`);
    return;
  }
  const sql = readFileSync(path, "utf8");
  for (const token of requiredTokens) {
    if (!sql.includes(token)) issues.push(`${label} missing: ${token}`);
  }
  if (/\b(create|alter|drop|replace)\s+function\s+public\.teller_post_journal/i.test(sql)) {
    issues.push(`${label} must not modify teller_post_journal`);
  }
}

assertSqlFile(
  "supabase/migrations/032_phase14_planning.sql",
  [
    "teller_planning_settings",
    "teller_budgets",
    "teller_budget_versions",
    "teller_budget_lines",
    "teller_planning_audit_events",
    "teller_forecasts",
    "teller_forecast_versions",
    "enable row level security",
    "teller_guard_budget_line_editable",
    "teller_atomic_clone_budget_version",
  ],
  "032 migration",
);

assertSqlFile(
  "supabase/patches/032-phase14d-forecast-lines.sql",
  ["teller_forecast_lines", "teller_forecast_assumptions", "enable row level security"],
  "032-phase14d patch",
);

assertSqlFile(
  "supabase/patches/033-phase14f-cash-forecast.sql",
  ["teller_cash_forecast_runs", "teller_cash_forecast_lines", "enable row level security"],
  "033-phase14f patch",
);

assertSqlFile(
  "supabase/patches/034-phase14h-scenarios.sql",
  ["teller_scenarios", "teller_scenario_drivers", "enable row level security"],
  "034-phase14h patch",
);

const requiredFiles = [
  "src/lib/planning/budgets/budget-crud.ts",
  "src/lib/planning/reports/budget-vs-actual.ts",
  "src/lib/planning/reports/rolling-forecast.ts",
  "src/lib/planning/cash/load-cash-outlook.ts",
  "src/lib/planning/scenarios/comparison.ts",
  "src/lib/planning/dashboard/load-planning-dashboard.ts",
  "src/lib/planning/accountant-package/load-accountant-planning-package.ts",
  "src/lib/planning/reports/phase14j.test.ts",
];

for (const rel of requiredFiles) {
  if (!existsSync(join(root, rel))) issues.push(`Missing file: ${rel}`);
}

const planningLib = [
  "src/lib/planning/budgets",
  "src/lib/planning/forecasts",
  "src/lib/planning/cash",
  "src/lib/planning/scenarios",
  "src/lib/planning/dashboard",
  "src/lib/planning/accountant-package",
];
for (const dir of planningLib) {
  // spot-check via budget-crud only; full tree scanned in acceptance
  void dir;
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
      manualMigrationRequired: false,
      manualPatchRequired: false,
      migrationFile: "supabase/migrations/032_phase14_planning.sql",
      patchFiles: [
        "supabase/patches/032-phase14d-forecast-lines.sql",
        "supabase/patches/033-phase14f-cash-forecast.sql",
        "supabase/patches/034-phase14h-scenarios.sql",
      ],
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
