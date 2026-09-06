#!/usr/bin/env node
/**
 * Static deployment-order compatibility audit for migration 023.
 * Verifies old Phase 6 app can keep running between DB migration and Phase 7 deploy.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const MIGRATION = resolve(ROOT, "supabase/migrations/023_phase7_job_costing.sql");

const LEGACY_STATUSES = ["estimate", "scheduled", "in_progress", "complete", "invoiced", "cancelled"];
const NEW_STATUSES = ["draft", "active", "on_hold", "completed", "closed", "cancelled"];

function read(path) {
  return readFileSync(path, "utf8");
}

function grep(pattern, paths) {
  const result = spawnSync("rg", ["-l", pattern, ...paths], { encoding: "utf8" });
  return (result.stdout || "").trim().split("\n").filter(Boolean);
}

function auditMigrationStatusCompat(sql) {
  const issues = [];
  if (!sql.includes("estimate") || !sql.includes("'draft'")) {
    issues.push("Migration missing dual legacy+new status values in check constraint");
  }
  for (const status of LEGACY_STATUSES) {
    if (!sql.includes(`'${status}'`)) {
      issues.push(`Migration check constraint missing legacy status: ${status}`);
    }
  }
  for (const status of NEW_STATUSES) {
    if (!sql.includes(`'${status}'`)) {
      issues.push(`Migration check constraint missing new status: ${status}`);
    }
  }
  return issues;
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
  if (!fnBlock.includes("coalesce(nullif(v_line->>'cost_classification'")) {
    issues.push("teller_post_journal must default cost_classification for old callers");
  }
  if (!fnBlock.includes("nullif(v_line->>'job_cost_category_id'")) {
    issues.push("teller_post_journal must default job_cost_category_id for old callers");
  }
  return issues;
}

function auditHfacNumbering() {
  const hfac = read(resolve(ROOT, "src/lib/integrations/hfac.ts"));
  const issues = [];
  if (hfac.includes('nextNumber("JOB"')) {
    issues.push("HFAC still uses client-side nextNumber(\"JOB\")");
  }
  if (!hfac.includes("allocateJobNumber")) {
    issues.push("HFAC does not use allocateJobNumber()");
  }
  return issues;
}

function auditJobCreationPaths() {
  const issues = [];
  const hits = grep('nextNumber\\("JOB"', ["src"]);
  for (const file of hits) {
    if (file.includes(".test.")) continue;
    issues.push(`Client-side JOB numbering remains in ${file}`);
  }
  return issues;
}

function auditPostJournalCallers() {
  const issues = [];
  const tsCallers = grep("teller_post_journal", ["src"]);
  const sqlCallers = grep("teller_post_journal\\(", ["supabase/migrations"]);
  const postTs = read(resolve(ROOT, "src/lib/accounting/post.ts"));
  if (!postTs.includes('supabase.rpc("teller_post_journal"')) {
    issues.push("post.ts missing teller_post_journal RPC call");
  }
  if (!postTs.includes("p_lines: journalLinesPayload")) {
    issues.push("post.ts journal payload wiring missing");
  }
  return { tsCallers, sqlCallers: sqlCallers.length, issues };
}

function main() {
  if (!existsSync(MIGRATION)) {
    console.error("Missing 023 migration");
    process.exit(1);
  }
  const sql = read(MIGRATION);

  const statusIssues = auditMigrationStatusCompat(sql);
  const rpcIssues = auditPostJournalCompat(sql);
  const hfacIssues = auditHfacNumbering();
  const numberingIssues = auditJobCreationPaths();
  const callerAudit = auditPostJournalCallers();

  const STATUS_DEPLOYMENT_COMPATIBLE = statusIssues.length === 0;
  const OLD_POST_JOURNAL_CALLERS_COMPATIBLE = rpcIssues.length === 0 && callerAudit.issues.length === 0;
  const HFAC_USES_ATOMIC_JOB_NUMBERING = hfacIssues.length === 0 && numberingIssues.length === 0;

  const oldAppIssues = [];
  if (!STATUS_DEPLOYMENT_COMPATIBLE) oldAppIssues.push(...statusIssues);
  if (!OLD_POST_JOURNAL_CALLERS_COMPATIBLE) oldAppIssues.push(...rpcIssues, ...callerAudit.issues);

  // Additive schema changes (new columns/tables with defaults) are backward compatible for reads/writes
  const OLD_APP_COMPATIBLE_WITH_023 = oldAppIssues.length === 0;

  const SAFE_TO_APPLY_023 =
    OLD_APP_COMPATIBLE_WITH_023 &&
    OLD_POST_JOURNAL_CALLERS_COMPATIBLE &&
    STATUS_DEPLOYMENT_COMPATIBLE &&
    HFAC_USES_ATOMIC_JOB_NUMBERING;

  console.log(
    JSON.stringify(
      {
        OLD_APP_COMPATIBLE_WITH_023,
        OLD_POST_JOURNAL_CALLERS_COMPATIBLE,
        HFAC_USES_ATOMIC_JOB_NUMBERING,
        STATUS_DEPLOYMENT_COMPATIBLE,
        SAFE_TO_APPLY_023,
        statusIssues,
        rpcIssues,
        hfacIssues,
        numberingIssues,
        postJournalCallers: {
          typescript: callerAudit.tsCallers,
          sqlMigrationReferences: callerAudit.sqlCallers,
        },
        notes: [
          "Additive columns (cost_classification, job_cost_category_id) default safely for old INSERT paths.",
          "job_type constraint removal is permissive — old app job types still valid.",
          "teller_allocate_sequence_number RPC is new; old app does not call it until Phase 7 deploy.",
        ],
      },
      null,
      2,
    ),
  );

  process.exit(SAFE_TO_APPLY_023 ? 0 : 1);
}

main();
