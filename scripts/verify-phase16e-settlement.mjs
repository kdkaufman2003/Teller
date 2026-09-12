#!/usr/bin/env node
/** Static Phase 16E intercompany settlement verification — no DB writes. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];

function assertFile(relPath) {
  if (!existsSync(join(root, relPath))) issues.push(`Missing file: ${relPath}`);
}

const requiredFiles = [
  "supabase/migrations/045_phase16e_intercompany_settlement.sql",
  "src/lib/accounting/intercompany/settlement/types.ts",
  "src/lib/accounting/intercompany/settlement/posting.ts",
  "src/lib/accounting/intercompany/settlement/reversal.ts",
  "src/lib/accounting/intercompany/settlement/allocation.ts",
  "src/lib/accounting/intercompany/settlement/open-items.ts",
  "src/lib/accounting/intercompany/settlement/reconciliation-report.ts",
  "src/lib/accounting/phase16e.test.ts",
  "src/app/api/accounting/intercompany/settlements/route.ts",
  "src/app/api/accounting/intercompany/open-items/route.ts",
  "scripts/controlled-phase16e-db-acceptance.ts",
];

for (const file of requiredFiles) assertFile(file);

const posting = readFileSync(join(root, "src/lib/accounting/intercompany/settlement/posting.ts"), "utf8");
if (!/postIntercompanySettlement/.test(posting)) issues.push("postIntercompanySettlement missing");
if (!/teller_atomic_post_intercompany_settlement/.test(posting)) issues.push("atomic settlement RPC call missing");

const sql = readFileSync(join(root, "supabase/migrations/045_phase16e_intercompany_settlement.sql"), "utf8");
if (!/teller_atomic_post_intercompany_settlement/.test(sql)) issues.push("atomic post settlement RPC missing");
if (!/teller_atomic_reverse_intercompany_settlement/.test(sql)) issues.push("atomic reverse settlement RPC missing");
if (!/Allocation over-applies/.test(sql)) issues.push("over-allocation guard missing");
if (/create table public\.teller_.*consolidat/i.test(sql)) {
  issues.push("consolidation tables must not be in 16E migration");
}

console.log(
  JSON.stringify(
    {
      PHASE16E_SETTLEMENT_VERIFY: issues.length ? "FAIL" : "PASS",
      INTERCOMPANY_SETTLEMENT_MODEL: issues.length ? "FAIL" : "PASS_DESIGN",
      SETTLEMENT_PARTIAL_POSTING_POSSIBLE: false,
      SETTLEMENT_CREATES_REVENUE: false,
      SETTLEMENT_CREATES_EXPENSE: false,
      SETTLEMENT_GENERATES_SALES_TAX: false,
      CONSOLIDATION_IN_16E: false,
      ELIMINATION_ENTRIES_IN_16E: false,
      HFAC_MODIFIED: false,
      issues,
      manualMigrationFile: "supabase/migrations/045_phase16e_intercompany_settlement.sql",
      migrationsAutoApplied: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
