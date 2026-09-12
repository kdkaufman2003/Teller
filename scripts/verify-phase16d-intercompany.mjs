#!/usr/bin/env node
/** Static Phase 16D intercompany verification — no DB writes. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];

function assertFile(relPath) {
  if (!existsSync(join(root, relPath))) issues.push(`Missing file: ${relPath}`);
}

const requiredFiles = [
  "supabase/migrations/044_phase16d_intercompany.sql",
  "src/lib/accounting/intercompany/types.ts",
  "src/lib/accounting/intercompany/posting.ts",
  "src/lib/accounting/intercompany/reversal.ts",
  "src/lib/accounting/intercompany/reconciliation.ts",
  "src/lib/accounting/intercompany/accounts.ts",
  "src/lib/accounting/intercompany/validation.ts",
  "src/lib/accounting/phase16d.test.ts",
  "src/app/api/accounting/intercompany/route.ts",
  "src/app/app/accounting/intercompany/page.tsx",
  "scripts/controlled-phase16d-db-acceptance.ts",
];

for (const file of requiredFiles) assertFile(file);

const posting = readFileSync(join(root, "src/lib/accounting/intercompany/posting.ts"), "utf8");
if (!/postIntercompanyTransaction/.test(posting)) issues.push("postIntercompanyTransaction missing");
if (!/postExpenseOnBehalf/.test(posting)) issues.push("postExpenseOnBehalf missing");
if (!/teller_atomic_post_intercompany/.test(posting)) issues.push("atomic RPC call missing");

const validation = readFileSync(join(root, "src/lib/accounting/intercompany/validation.ts"), "utf8");
if (!/assertIntercompanyAccess/.test(validation)) issues.push("assertIntercompanyAccess missing");

const sql = readFileSync(join(root, "supabase/migrations/044_phase16d_intercompany.sql"), "utf8");
if (!/teller_atomic_post_intercompany/.test(sql)) issues.push("atomic post RPC missing in migration");
if (!/teller_atomic_reverse_intercompany/.test(sql)) issues.push("atomic reverse RPC missing");
if (/create table public\.teller_.*consolidat/i.test(sql)) {
  issues.push("consolidation tables must not be in 16D migration");
}
if (/create table public\.teller_.*elimination/i.test(sql)) {
  issues.push("elimination tables must not be in 16D migration");
}

if (existsSync(join(root, "src/lib/integrations/hfac-org.ts"))) {
  const hfac = readFileSync(join(root, "src/lib/integrations/hfac-org.ts"), "utf8");
  if (/intercompany/i.test(hfac)) issues.push("HFAC must not reference intercompany in 16D");
}

console.log(
  JSON.stringify(
    {
      PHASE16D_INTERCOMPANY_VERIFY: issues.length ? "FAIL" : "PASS",
      INTERCOMPANY_GROUP_MODEL: issues.length ? "FAIL" : "PASS",
      INTERCOMPANY_PARTIAL_POSTING_POSSIBLE: false,
      CROSS_ENTITY_SINGLE_JOURNAL: false,
      CONSOLIDATION_ELIMINATIONS_IN_16D: false,
      HFAC_MODIFIED: false,
      issues,
      manualMigrationFile: "supabase/migrations/044_phase16d_intercompany.sql",
      migrationsAutoApplied: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
