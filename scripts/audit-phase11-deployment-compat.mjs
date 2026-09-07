#!/usr/bin/env node
/** Static deployment-order compatibility audit for migration 027. */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const M027 = resolve(ROOT, "supabase/migrations/027_phase11_subledger_automation.sql");
const M026 = resolve(ROOT, "supabase/migrations/026_phase10_financial_reporting.sql");

function read(path) {
  return readFileSync(path, "utf8");
}

function auditMigration027(sql) {
  const issues = [];
  if (!existsSync(M027)) issues.push("Missing 027_phase11_subledger_automation.sql");
  if (/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(sql)) {
    issues.push("027 must not replace teller_post_journal");
  }
  if (/alter table public.teller_journal_entries/i.test(sql)) {
    issues.push("027 must not alter teller_journal_entries");
  }
  if (!sql.includes("teller_accounting_schedules")) issues.push("027 must add teller_accounting_schedules");
  if (!sql.includes("teller_schedule_occurrences")) issues.push("027 must add teller_schedule_occurrences");
  if (!sql.includes("unique (organization_id, idempotency_key)")) {
    issues.push("027 must enforce occurrence idempotency");
  }
  if (!sql.includes("enable row level security")) issues.push("027 must enable RLS");
  return issues;
}

function main() {
  const sql = existsSync(M027) ? read(M027) : "";
  const migrationIssues = auditMigration027(sql);
  const postTs = read(resolve(ROOT, "src/lib/accounting/post.ts"));
  const postOk = postTs.includes('supabase.rpc("teller_post_journal"');
  const m026 = existsSync(M026) ? read(M026) : "";
  const phase10Intact = m026.includes("teller_gl_account_totals");

  const OLD_PHASE10_APP_COMPATIBLE_WITH_027 = migrationIssues.length === 0 && phase10Intact;
  const TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED =
    postOk && !/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(sql);

  console.log(
    JSON.stringify(
      {
        DEPLOYMENT_COMPAT_AUDIT: OLD_PHASE10_APP_COMPATIBLE_WITH_027 && TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED ? "PASS" : "FAIL",
        OLD_PHASE10_APP_COMPATIBLE_WITH_027,
        TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED,
        migrationIssues,
        phase10ReportingIntact: phase10Intact,
        phase11RunnerPresent: existsSync(resolve(ROOT, "scripts/controlled-phase11-demo-runner.ts")),
        phase11TestsPresent: existsSync(resolve(ROOT, "src/lib/accounting/phase11.test.ts")),
      },
      null,
      2,
    ),
  );

  process.exit(OLD_PHASE10_APP_COMPATIBLE_WITH_027 && TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED ? 0 : 1);
}

main();
