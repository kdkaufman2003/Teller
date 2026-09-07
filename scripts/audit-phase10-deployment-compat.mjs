#!/usr/bin/env node
/**
 * Static deployment-order compatibility audit for migration 026.
 * Verifies Phase 9 app remains compatible with additive Phase 10 schema.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const MIGRATION = resolve(ROOT, "supabase/migrations/026_phase10_financial_reporting.sql");

function read(path) {
  return readFileSync(path, "utf8");
}

function grep(pattern, paths) {
  const result = spawnSync("rg", ["-l", pattern, ...paths], { encoding: "utf8" });
  return (result.stdout || "").trim().split("\n").filter(Boolean);
}

function auditMigration026(sql) {
  const issues = [];
  if (!existsSync(MIGRATION)) issues.push("Missing 026_phase10_financial_reporting.sql");
  if (sql.includes("drop table public.teller_accounts")) {
    issues.push("026 must not drop teller_accounts");
  }
  if (sql.includes("alter table public.teller_journal_entries")) {
    issues.push("026 must not alter teller_journal_entries");
  }
  if (!sql.includes("cash_flow_category")) {
    issues.push("026 should add cash_flow_category to teller_accounts");
  }
  if (!sql.includes("teller_report_line_groups")) {
    issues.push("026 should add teller_report_line_groups");
  }
  if (!sql.includes("teller_gl_account_totals")) {
    issues.push("026 should add teller_gl_account_totals RPC");
  }
  return issues;
}

function auditPostJournalUntouched() {
  const postTs = read(resolve(ROOT, "src/lib/accounting/post.ts"));
  const issues = [];
  if (!postTs.includes('supabase.rpc("teller_post_journal"')) {
    issues.push("post.ts must still call teller_post_journal RPC");
  }
  return issues;
}

function main() {
  const sql = existsSync(MIGRATION) ? read(MIGRATION) : "";
  const migrationIssues = auditMigration026(sql);
  const postIssues = auditPostJournalUntouched();
  const reportEngine = grep("report-engine", ["src/lib/accounting"]);
  const phase10Tests = existsSync(resolve(ROOT, "src/lib/accounting/phase10.test.ts"));
  const runner = existsSync(resolve(ROOT, "scripts/controlled-phase10-demo-runner.ts"));

  const OLD_PHASE9_APP_COMPATIBLE_WITH_026 = migrationIssues.length === 0;
  const PHASE1_9_POSTING_PATHS_COMPATIBLE = postIssues.length === 0;

  console.log(
    JSON.stringify(
      {
        OLD_PHASE9_APP_COMPATIBLE_WITH_026,
        PHASE1_9_POSTING_PATHS_COMPATIBLE,
        MIGRATION_026_ADDITIVE: migrationIssues.length === 0,
        migrationIssues,
        postIssues,
        reportEngineFiles: reportEngine.length,
        phase10UnitTestsPresent: phase10Tests,
        phase10RunnerPresent: runner,
        notes: [
          "026 is additive: cash_flow_category, report line groups, GL totals RPC.",
          "Phase 9 teller_post_journal and period close paths must remain unchanged.",
          "Do not apply 026 to production until Phase 10 acceptance.",
        ],
      },
      null,
      2,
    ),
  );

  process.exit(
    OLD_PHASE9_APP_COMPATIBLE_WITH_026 && PHASE1_9_POSTING_PATHS_COMPATIBLE ? 0 : 1,
  );
}

main();
