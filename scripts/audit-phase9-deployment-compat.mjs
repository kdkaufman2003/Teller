#!/usr/bin/env node
/**
 * Static deployment-order compatibility audit for migration 025.
 * Verifies old Phase 8 app can keep running between DB migration and Phase 9 deploy.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const MIGRATION = resolve(ROOT, "supabase/migrations/025_phase9_month_end_close.sql");

function read(path) {
  return readFileSync(path, "utf8");
}

function grep(pattern, paths) {
  const result = spawnSync("rg", ["-l", pattern, ...paths], { encoding: "utf8" });
  return (result.stdout || "").trim().split("\n").filter(Boolean);
}

function auditPostJournalCompat(sql) {
  const issues = [];
  const sig = "create or replace function public.teller_post_journal(";
  if (!sql.includes(sig)) return ["Migration does not define teller_post_journal"];
  const fnBlock = sql.slice(sql.indexOf(sig));
  const paramCount = (fnBlock.match(/^[^)]*\)/s)?.[0].match(/p_/g) || []).length;
  if (paramCount !== 7) {
    issues.push(`teller_post_journal parameter count changed (${paramCount}, expected 7)`);
  }
  if (!fnBlock.includes("nullif(v_line->>'fixed_asset_id'")) {
    issues.push("teller_post_journal must default fixed_asset_id for old callers");
  }
  if (!fnBlock.includes("v_closed_through := public.teller_books_closed_through")) {
    issues.push("teller_post_journal must enforce period lock via teller_books_closed_through");
  }
  return issues;
}

function auditPostJournalCallers() {
  const issues = [];
  const postTs = read(resolve(ROOT, "src/lib/accounting/post.ts"));
  if (!postTs.includes('supabase.rpc("teller_post_journal"')) {
    issues.push("post.ts missing teller_post_journal RPC call");
  }
  if (!postTs.includes("p_lines: journalLinesPayload")) {
    issues.push("post.ts journal payload wiring missing");
  }
  return { issues, tsCallers: grep("teller_post_journal", ["src"]), sqlCallers: grep("teller_post_journal\\(", ["supabase/migrations"]).length };
}

function auditPeriodGuard(sql) {
  const issues = [];
  if (!sql.includes("create or replace function public.teller_journal_entries_period_guard()")) {
    issues.push("Missing teller_journal_entries_period_guard trigger function");
  }
  if (!sql.includes("create trigger teller_journal_entries_period_guard")) {
    issues.push("Missing teller_journal_entries_period_guard trigger");
  }
  if (sql.includes("teller.skip_period_lock")) {
    issues.push("Generic teller.skip_period_lock bypass must not be present");
  }
  if (!sql.includes("teller_acquire_org_accounting_lock")) {
    issues.push("Missing teller_acquire_org_accounting_lock for posting/close serialization");
  }
  return issues;
}

function auditAccountingWatermark(sql) {
  const issues = [];
  if (!sql.includes("teller_accounting_state_versions")) {
    issues.push("Missing teller_accounting_state_versions table");
  }
  if (!sql.includes("teller_increment_accounting_version")) {
    issues.push("Missing teller_increment_accounting_version");
  }
  if (!sql.includes("p_expected_accounting_version")) {
    issues.push("Close RPC must validate p_expected_accounting_version");
  }
  if (!sql.includes("ACCOUNTING_STATE_CHANGED")) {
    issues.push("Close RPC must raise ACCOUNTING_STATE_CHANGED on stale watermark");
  }
  if (!sql.includes("teller_period_closes_legacy_delete_to_reopen")) {
    issues.push("Missing legacy DELETE-to-reopen trigger for Phase 8 app compat");
  }
  return issues;
}

function auditDirectInsertPoliciesRemoved(sql) {
  const issues = [];
  if (!sql.includes('drop policy if exists "teller writers insert journal entries"')) {
    issues.push('Migration must drop "teller writers insert journal entries" policy');
  }
  if (!sql.includes('drop policy if exists "teller writers insert journal lines"')) {
    issues.push('Migration must drop "teller writers insert journal lines" policy');
  }
  return issues;
}

function auditCloseReopenGrants(sql) {
  const issues = [];
  if (!sql.includes("create or replace function public.teller_close_accounting_period(")) {
    issues.push("Missing teller_close_accounting_period RPC");
  }
  if (!sql.includes("create or replace function public.teller_reopen_accounting_period(")) {
    issues.push("Missing teller_reopen_accounting_period RPC");
  }
  const closeGrant = sql.match(
    /grant execute on function public\.teller_close_accounting_period[\s\S]*?;/,
  );
  const reopenGrant = sql.match(
    /grant execute on function public\.teller_reopen_accounting_period[\s\S]*?;/,
  );
  if (!closeGrant?.[0]?.includes("to authenticated")) {
    issues.push("teller_close_accounting_period must grant execute to authenticated");
  }
  if (!closeGrant?.[0]?.includes("service_role")) {
    issues.push("teller_close_accounting_period must grant execute to service_role");
  }
  if (!reopenGrant?.[0]?.includes("to authenticated")) {
    issues.push("teller_reopen_accounting_period must grant execute to authenticated");
  }
  if (!reopenGrant?.[0]?.includes("service_role")) {
    issues.push("teller_reopen_accounting_period must grant execute to service_role");
  }
  return issues;
}

function auditAdditiveSchema(sql) {
  const issues = [];
  const destructivePatterns = [
    /drop table public\.teller_journal_entries/i,
    /drop table public\.teller_journal_lines/i,
    /drop table public\.teller_accounts/i,
    /alter table public\.teller_journal_entries drop column/i,
  ];
  for (const pattern of destructivePatterns) {
    if (pattern.test(sql)) issues.push(`Migration contains destructive change: ${pattern}`);
  }
  for (const table of [
    "teller_close_settings",
    "teller_period_close_reviews",
    "teller_close_checklist_items",
    "teller_adjusting_journal_entries",
    "teller_recurring_journal_templates",
    "teller_recurring_journal_runs",
    "teller_accounting_state_versions",
  ]) {
    if (!sql.includes(table)) issues.push(`Migration missing table ${table}`);
  }
  if (!sql.includes("add column if not exists event_type")) {
    issues.push("Migration must evolve teller_period_closes with IF NOT EXISTS columns");
  }
  return issues;
}

function main() {
  if (!existsSync(MIGRATION)) {
    console.error("Missing 025 migration");
    process.exit(1);
  }
  const sql = read(MIGRATION);

  const rpcIssues = [
    ...auditPostJournalCompat(sql),
    ...auditPeriodGuard(sql),
    ...auditAccountingWatermark(sql),
    ...auditDirectInsertPoliciesRemoved(sql),
    ...auditCloseReopenGrants(sql),
  ];
  const schemaIssues = auditAdditiveSchema(sql);
  const callerAudit = auditPostJournalCallers();

  const OLD_POST_JOURNAL_CALLERS_COMPATIBLE = rpcIssues.length === 0 && callerAudit.issues.length === 0;
  const ADDITIVE_SCHEMA_COMPATIBLE = schemaIssues.length === 0;
  const OLD_APP_COMPATIBLE_WITH_025 =
    OLD_POST_JOURNAL_CALLERS_COMPATIBLE && ADDITIVE_SCHEMA_COMPATIBLE;
  const SAFE_TO_APPLY_025 = OLD_APP_COMPATIBLE_WITH_025;

  console.log(
    JSON.stringify(
      {
        OLD_APP_COMPATIBLE_WITH_025,
        OLD_POST_JOURNAL_CALLERS_COMPATIBLE,
        ADDITIVE_SCHEMA_COMPATIBLE,
        SAFE_TO_APPLY_025,
        rpcIssues,
        schemaIssues,
        postJournalCallers: {
          typescript: callerAudit.tsCallers,
          sqlMigrationReferences: callerAudit.sqlCallers,
          issues: callerAudit.issues,
        },
        notes: [
          "New close/AJE/recurring tables are additive; old app does not query them until Phase 9 deploy.",
          "teller_post_journal signature unchanged (7 params) — old callers continue working.",
          "Legacy DELETE reopen preserved via teller_period_closes_legacy_delete_to_reopen trigger + API route.",
          "Phase 8 deployed UI (8bbd89b) uses DELETE /api/accounting/periods — must not return 410 after 025.",
          "Period guard trigger adds defense-in-depth; teller_post_journal also checks closed-through.",
          "teller_close_accounting_period / teller_reopen_accounting_period granted to authenticated + service_role.",
        ],
      },
      null,
      2,
    ),
  );

  process.exit(SAFE_TO_APPLY_025 ? 0 : 1);
}

main();
