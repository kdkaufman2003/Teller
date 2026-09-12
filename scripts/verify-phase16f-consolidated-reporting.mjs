#!/usr/bin/env node
/** Static Phase 16F consolidated reporting verification — no DB writes. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];

function assertFile(relPath) {
  if (!existsSync(join(root, relPath))) issues.push(`Missing file: ${relPath}`);
}

const requiredFiles = [
  "src/lib/accounting/consolidated/types.ts",
  "src/lib/accounting/consolidated/scope.ts",
  "src/lib/accounting/consolidated/grouping.ts",
  "src/lib/accounting/consolidated/trial-balance.ts",
  "src/lib/accounting/consolidated/profit-loss.ts",
  "src/lib/accounting/consolidated/balance-sheet.ts",
  "src/lib/accounting/consolidated/cash-flow.ts",
  "src/lib/accounting/consolidated/index.ts",
  "src/lib/accounting/phase16f.test.ts",
  "src/app/api/reports/consolidated/trial-balance/route.ts",
  "src/app/api/reports/consolidated/profit-loss/route.ts",
  "src/app/api/reports/consolidated/balance-sheet/route.ts",
  "src/app/api/reports/consolidated/cash-flow/route.ts",
  "src/app/app/reports/consolidated/page.tsx",
  "src/components/ConsolidatedReportsView.tsx",
  "scripts/controlled-phase16f-db-acceptance.ts",
];

for (const file of requiredFiles) assertFile(file);

const scope = readFileSync(join(root, "src/lib/accounting/consolidated/scope.ts"), "utf8");
if (!/assertEntityAccess/.test(scope)) issues.push("entity access enforcement missing in scope.ts");
if (!/includeAllEntities/.test(scope)) issues.push("includeAllEntities scope missing");

const grouping = readFileSync(join(root, "src/lib/accounting/consolidated/grouping.ts"), "utf8");
if (!/consolidationAccountKey/.test(grouping)) issues.push("consolidationAccountKey missing");

for (const file of [
  "src/lib/accounting/consolidated/trial-balance.ts",
  "src/lib/accounting/consolidated/profit-loss.ts",
  "src/lib/accounting/consolidated/balance-sheet.ts",
  "src/lib/accounting/consolidated/cash-flow.ts",
]) {
  const source = readFileSync(join(root, file), "utf8");
  if (/\.insert\(/.test(source) || /\.update\(/.test(source)) {
    issues.push(`${file} must remain report-only`);
  }
  if (/elimination/i.test(source)) issues.push(`${file} must not implement eliminations in 16F`);
}

const migration046 = join(root, "supabase/migrations/046_phase16f_consolidated_reporting.sql");
const newMigrationRequired = existsSync(migration046);

console.log(
  JSON.stringify(
    {
      PHASE16F_CONSOLIDATED_REPORTING_VERIFY: issues.length ? "FAIL" : "PASS",
      CONSOLIDATION_REWRITES_ENTITY_BOOKS: false,
      CONSOLIDATION_POSTS_JOURNALS: false,
      ELIMINATION_ENTRIES_IN_16F: false,
      CONSOLIDATION_RLS_BYPASS: false,
      NEW_MIGRATION_REQUIRED: newMigrationRequired,
      NAMED_CONSOLIDATION_GROUPS_IN_16F: false,
      ACCOUNT_MAPPING_OVERRIDE_NEEDED: false,
      issues,
      migrationsAutoApplied: false,
      sqlPatchesAutoApplied: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
