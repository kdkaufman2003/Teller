#!/usr/bin/env node
/** Static deployment-order compatibility audit for migration 031. */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const M031 = resolve(ROOT, "supabase/migrations/031_phase13_inventory.sql");
const M030 = resolve(ROOT, "supabase/migrations/030_phase12_payroll_atomic_rpc.sql");

function auditMigration031(sql) {
  const issues = [];
  if (!existsSync(M031)) issues.push("Missing 031_phase13_inventory.sql");
  if (/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(sql)) {
    issues.push("031 must not replace teller_post_journal");
  }
  for (const table of [
    "teller_inventory_items",
    "teller_inventory_locations",
    "teller_inventory_movements",
    "teller_inventory_balances",
    "teller_inventory_counts",
    "teller_inventory_count_lines",
    "teller_inventory_account_mappings",
    "teller_inventory_receipt_bill_allocations",
  ]) {
    if (!sql.includes(table)) issues.push(`031 must add ${table}`);
  }
  for (const rpc of [
    "teller_atomic_receive_inventory",
    "teller_atomic_issue_inventory",
    "teller_atomic_transfer_inventory",
    "teller_atomic_reverse_inventory_movement",
    "teller_atomic_settle_inventory_receipt_bill",
    "teller_atomic_reverse_inventory_receipt_bill_allocation",
  ]) {
    if (!sql.includes(rpc)) issues.push(`031 must define ${rpc}`);
  }
  if (!sql.includes("enable row level security")) issues.push("031 must enable RLS");
  if (!sql.includes("unique (organization_id, idempotency_key)")) {
    issues.push("031 must enforce movement idempotency");
  }
  return issues;
}

function main() {
  const sql = existsSync(M031) ? readFileSync(M031, "utf8") : "";
  const migrationIssues = auditMigration031(sql);
  const postTs = readFileSync(resolve(ROOT, "src/lib/accounting/post.ts"), "utf8");
  const postOk = postTs.includes('supabase.rpc("teller_post_journal"');
  const m030 = existsSync(M030) ? readFileSync(M030, "utf8") : "";
  const phase12Intact = m030.includes("teller_atomic_post_payroll_run");

  const OLD_PHASE12_APP_COMPATIBLE_WITH_031 =
    migrationIssues.length === 0 && phase12Intact;
  const TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED =
    postOk && !/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(sql);

  console.log(
    JSON.stringify(
      {
        DEPLOYMENT_COMPAT_AUDIT:
          OLD_PHASE12_APP_COMPATIBLE_WITH_031 && TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED
            ? "PASS"
            : "FAIL",
        OLD_PHASE12_APP_COMPATIBLE_WITH_031,
        TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED,
        MIGRATION_031_REQUIRED: true,
        MIGRATION_031_CREATED: existsSync(M031),
        MIGRATION_031_APPLIED: false,
        GRNI_IN_MIGRATION_031: sql.includes("teller_inventory_receipt_bill_allocations"),
        migrationIssues,
        phase12Intact,
        phase13RunnerPresent: existsSync(resolve(ROOT, "scripts/controlled-phase13-demo-runner.ts")),
        phase13TestsPresent: existsSync(resolve(ROOT, "src/lib/accounting/phase13.test.ts")),
        PRODUCTION_SCHEDULER_ENABLED: false,
        PHASE_13_COMPLETE: false,
        PRODUCTION_DEPLOYED: false,
      },
      null,
      2,
    ),
  );

  process.exit(OLD_PHASE12_APP_COMPATIBLE_WITH_031 && TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED ? 0 : 1);
}

main();
