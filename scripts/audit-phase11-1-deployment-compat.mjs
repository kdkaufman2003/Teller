#!/usr/bin/env node
/** Static deployment-order compatibility audit for migration 028. */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const M028 = resolve(ROOT, "supabase/migrations/028_phase11_1_accrual_settlement.sql");
const M027 = resolve(ROOT, "supabase/migrations/027_phase11_subledger_automation.sql");

function read(path) {
  return readFileSync(path, "utf8");
}

function auditMigration028(sql) {
  const issues = [];
  if (!existsSync(M028)) issues.push("Missing 028_phase11_1_accrual_settlement.sql");
  if (/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(sql)) {
    issues.push("028 must not replace teller_post_journal");
  }
  if (!sql.includes("teller_accrual_settlements")) issues.push("028 must add teller_accrual_settlements");
  if (!sql.includes("teller_accrual_settlement_allocations")) {
    issues.push("028 must add teller_accrual_settlement_allocations");
  }
  if (!sql.includes("teller_scheduler_runs")) issues.push("028 must add teller_scheduler_runs");
  if (!sql.includes("enable row level security")) issues.push("028 must enable RLS");
  if (!sql.includes("actual_amount_allocated")) issues.push("028 must store actual_amount_allocated");
  if (!sql.includes("accrual_settlement_portion")) issues.push("028 must store settlement portion breakdown");
  if (!sql.includes("teller_accrual_allocation_capacity_check")) {
    issues.push("028 must prevent over-settlement");
  }
  return issues;
}

function main() {
  const sql = existsSync(M028) ? read(M028) : "";
  const migrationIssues = auditMigration028(sql);
  const postTs = read(resolve(ROOT, "src/lib/accounting/post.ts"));
  const postOk = postTs.includes('supabase.rpc("teller_post_journal"');
  const m027 = existsSync(M027) ? read(M027) : "";
  const phase11Intact = m027.includes("teller_accounting_schedules");

  const OLD_PHASE11_APP_COMPATIBLE_WITH_028 = migrationIssues.length === 0 && phase11Intact;
  const TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED =
    postOk && !/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(sql);

  console.log(
    JSON.stringify(
      {
        DEPLOYMENT_COMPAT_AUDIT:
          OLD_PHASE11_APP_COMPATIBLE_WITH_028 && TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED
            ? "PASS"
            : "FAIL",
        OLD_PHASE11_APP_COMPATIBLE_WITH_028,
        TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED,
        MIGRATION_028_REQUIRED: true,
        MIGRATION_028_CREATED: existsSync(M028),
        MIGRATION_028_APPLIED: false,
        migrationIssues,
        phase11Intact,
        phase11_1RunnerPresent: existsSync(resolve(ROOT, "scripts/controlled-phase11-1-demo-runner.ts")),
        phase11_1TestsPresent: existsSync(resolve(ROOT, "src/lib/accounting/phase11-1.test.ts")),
        PRODUCTION_SCHEDULER_ENABLED: false,
      },
      null,
      2,
    ),
  );

  process.exit(OLD_PHASE11_APP_COMPATIBLE_WITH_028 && TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED ? 0 : 1);
}

main();
