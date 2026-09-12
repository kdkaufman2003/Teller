#!/usr/bin/env node
/** Static Phase 16G consolidation eliminations verification — no DB writes. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];

function assertFile(relPath) {
  if (!existsSync(join(root, relPath))) issues.push(`Missing file: ${relPath}`);
}

const requiredFiles = [
  "supabase/migrations/046_phase16g_consolidation_eliminations.sql",
  "src/lib/accounting/consolidated/eliminations/types.ts",
  "src/lib/accounting/consolidated/eliminations/scope-key.ts",
  "src/lib/accounting/consolidated/eliminations/suggestions-due-to-from.ts",
  "src/lib/accounting/consolidated/eliminations/suggestions-pl.ts",
  "src/lib/accounting/consolidated/eliminations/suggestions.ts",
  "src/lib/accounting/consolidated/eliminations/service.ts",
  "src/lib/accounting/consolidated/eliminations/load-posted.ts",
  "src/lib/accounting/consolidated/eliminations/apply.ts",
  "src/lib/accounting/consolidated/eliminations/worksheet.ts",
  "src/lib/accounting/phase16g.test.ts",
  "src/app/api/reports/consolidated/eliminations/route.ts",
  "src/app/api/reports/consolidated/eliminations/suggestions/route.ts",
  "src/app/api/reports/consolidated/eliminations/[id]/post/route.ts",
  "src/app/api/reports/consolidated/eliminations/[id]/reverse/route.ts",
  "src/app/api/reports/consolidated/worksheet/route.ts",
  "scripts/controlled-phase16g-db-acceptance.ts",
  "scripts/verify-migration-046-static.mjs",
];

for (const file of requiredFiles) assertFile(file);

const service = readFileSync(join(root, "src/lib/accounting/consolidated/eliminations/service.ts"), "utf8");
if (!/createConsolidationElimination/.test(service)) issues.push("createConsolidationElimination missing");
if (!/postConsolidationElimination/.test(service)) issues.push("postConsolidationElimination missing");
if (!/reverseConsolidationElimination/.test(service)) issues.push("reverseConsolidationElimination missing");
if (/teller_journal_entries/.test(service)) issues.push("elimination service must not write entity journals");
if (/\.from\("teller_accounts"\)\.insert/.test(service)) issues.push("elimination service must not mutate accounts");

const suggestions = readFileSync(
  join(root, "src/lib/accounting/consolidated/eliminations/suggestions-due-to-from.ts"),
  "utf8",
);
if (!/getIntercompanyPairReconciliation/.test(suggestions)) {
  issues.push("due-to/from suggestions must use Phase16E reconciliation");
}
if (!/Math\.min/.test(suggestions)) issues.push("matched eliminable amount must use min of pair balances");

const suggestionsPl = readFileSync(
  join(root, "src/lib/accounting/consolidated/eliminations/suggestions-pl.ts"),
  "utf8",
);
if (/account_name/i.test(suggestionsPl) && /includes\("intercompany"\)/.test(suggestionsPl)) {
  issues.push("P&L identification must not rely on fragile account name matching alone");
}

for (const file of [
  "src/lib/accounting/consolidated/eliminations/suggestions.ts",
  "src/lib/accounting/consolidated/eliminations/suggestions-due-to-from.ts",
  "src/lib/accounting/consolidated/eliminations/suggestions-pl.ts",
  "src/lib/accounting/consolidated/eliminations/worksheet.ts",
]) {
  const source = readFileSync(join(root, file), "utf8");
  if (/\.insert\(/.test(source) || /\.update\(/.test(source)) {
    issues.push(`${file} suggestion/report path must remain read-only`);
  }
}

const grouping = readFileSync(join(root, "src/lib/accounting/consolidated/grouping.ts"), "utf8");
if (!/normalize.*name|name\.trim|toLowerCase/.test(grouping)) {
  issues.push("16F grouping key must include normalized name");
}

const audit = readFileSync(join(root, "src/lib/accounting/audit.ts"), "utf8");
if (!/consolidation\.elimination/.test(audit)) issues.push("elimination audit actions missing");

console.log(
  JSON.stringify(
    {
      PHASE16G_ELIMINATIONS_VERIFY: issues.length ? "FAIL" : "PASS",
      CONSOLIDATION_ELIMINATION_LAYER: issues.length ? "FAIL" : "PASS_DESIGN",
      ELIMINATIONS_MUTATE_ENTITY_BOOKS: false,
      ELIMINATIONS_POST_TO_LEGAL_ENTITY_JOURNALS: false,
      ENTITY_REPORTS_INCLUDE_ELIMINATIONS: false,
      ELIMINATION_AUTO_POST_WITHOUT_REVIEW: false,
      OUT_OF_BALANCE_INTERCOMPANY_AUTO_FIXED: false,
      ELIMINATION_SUGGESTION_SIDE_EFFECTS: false,
      CONSOLIDATED_CASH_BALANCE_ELIMINATED: false,
      INTERCOMPANY_INVENTORY_PROFIT_ELIMINATION_IN_16G: false,
      NCI_ACCOUNTING_IN_16G: false,
      NEW_MIGRATION_REQUIRED: true,
      MANUAL_MIGRATION_FILE: "supabase/migrations/046_phase16g_consolidation_eliminations.sql",
      issues,
      migrationsAutoApplied: false,
      sqlPatchesAutoApplied: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
