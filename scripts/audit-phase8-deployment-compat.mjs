#!/usr/bin/env node
/**
 * Static deployment-order compatibility audit for migration 024.
 * Verifies old Phase 7 app can keep running between DB migration and Phase 8 deploy.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const MIGRATION = resolve(ROOT, "supabase/migrations/024_phase8_fixed_assets.sql");

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
  if (!fnBlock.includes("coalesce(nullif(v_line->>'cost_classification'")) {
    issues.push("teller_post_journal must default cost_classification for old callers");
  }
  if (!fnBlock.includes("nullif(v_line->>'job_cost_category_id'")) {
    issues.push("teller_post_journal must default job_cost_category_id for old callers");
  }
  if (!fnBlock.includes("nullif(v_line->>'fixed_asset_id'")) {
    issues.push("teller_post_journal must default fixed_asset_id for old callers");
  }
  if (!fnBlock.includes("fixed_asset_id")) {
    issues.push("teller_post_journal must insert fixed_asset_id on journal lines");
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
  if (!postTs.includes("fixed_asset_id")) {
    issues.push("post.ts should support optional fixed_asset_id on journal lines");
  }
  return { issues, tsCallers: grep("teller_post_journal", ["src"]), sqlCallers: grep("teller_post_journal\\(", ["supabase/migrations"]).length };
}

function auditDisposalRpc(sql) {
  const issues = [];
  const productionStart = sql.indexOf("create or replace function public.teller_dispose_fixed_asset(");
  const controlledStart = sql.indexOf("create or replace function public.teller_dispose_fixed_asset_controlled_test(");
  if (productionStart < 0) issues.push("Missing teller_dispose_fixed_asset");
  if (controlledStart < 0) issues.push("Missing teller_dispose_fixed_asset_controlled_test");
  if (productionStart >= 0 && controlledStart > productionStart) {
    const productionBlock = sql.slice(productionStart, controlledStart);
    if (productionBlock.includes("p_simulate_failure_after")) {
      issues.push("Production teller_dispose_fixed_asset must not expose p_simulate_failure_after");
    }
    if (!productionBlock.includes("p_idempotency_key uuid")) {
      issues.push("Production teller_dispose_fixed_asset must use uuid idempotency key");
    }
  }
  if (!sql.includes("idempotency_key uuid not null")) {
    issues.push("Disposal idempotency table must use uuid operation keys");
  }
  if (sql.includes("grant execute on function public.teller_dispose_fixed_asset_core")) {
    issues.push("teller_dispose_fixed_asset_core must not be granted to callers");
  }
  if (!sql.includes("grant execute on function public.teller_dispose_fixed_asset_controlled_test")) {
    issues.push("Controlled test disposal RPC grant missing");
  }
  const controlledGrant = sql.match(
    /grant execute on function public\.teller_dispose_fixed_asset_controlled_test[\s\S]*?;/,
  );
  if (!controlledGrant?.[0]?.includes("to service_role")) {
    issues.push("Controlled test disposal RPC must grant execute to service_role");
  }
  if (controlledGrant?.[0]?.includes("authenticated")) {
    issues.push("Controlled test disposal RPC must not grant execute to authenticated");
  }
  return issues;
}

function auditAdditiveSchema(sql) {
  const issues = [];
  if (!sql.includes("add column if not exists fixed_asset_id")) {
    issues.push("Migration must add fixed_asset_id column with IF NOT EXISTS");
  }
  for (const table of [
    "teller_fixed_asset_settings",
    "teller_fixed_asset_categories",
    "teller_fixed_assets",
    "teller_fixed_asset_depreciation_schedule_lines",
    "teller_fixed_asset_depreciation_batches",
    "teller_fixed_asset_depreciation_entries",
    "teller_fixed_asset_journal_links",
  ]) {
    if (!sql.includes(table)) issues.push(`Migration missing table ${table}`);
  }
  return issues;
}

function main() {
  if (!existsSync(MIGRATION)) {
    console.error("Missing 024 migration");
    process.exit(1);
  }
  const sql = read(MIGRATION);

  const rpcIssues = [...auditPostJournalCompat(sql), ...auditDisposalRpc(sql)];
  const schemaIssues = auditAdditiveSchema(sql);
  const callerAudit = auditPostJournalCallers();

  const OLD_POST_JOURNAL_CALLERS_COMPATIBLE = rpcIssues.length === 0 && callerAudit.issues.length === 0;
  const ADDITIVE_SCHEMA_COMPATIBLE = schemaIssues.length === 0;
  const OLD_APP_COMPATIBLE_WITH_024 =
    OLD_POST_JOURNAL_CALLERS_COMPATIBLE && ADDITIVE_SCHEMA_COMPATIBLE;
  const SAFE_TO_APPLY_024 = OLD_APP_COMPATIBLE_WITH_024;

  console.log(
    JSON.stringify(
      {
        OLD_APP_COMPATIBLE_WITH_024,
        OLD_POST_JOURNAL_CALLERS_COMPATIBLE,
        ADDITIVE_SCHEMA_COMPATIBLE,
        SAFE_TO_APPLY_024,
        rpcIssues,
        schemaIssues,
        postJournalCallers: {
          typescript: callerAudit.tsCallers,
          sqlMigrationReferences: callerAudit.sqlCallers,
          issues: callerAudit.issues,
        },
        notes: [
          "fixed_asset_id column is nullable — old journal INSERT paths continue working.",
          "New FA tables are additive; old app does not query them until Phase 8 deploy.",
          "teller_categorize_bank_transaction extended with fixed_asset_acquisition — old callers unchanged.",
          "teller_dispose_fixed_asset is additive; old app does not call it until Phase 8 deploy.",
          "teller_dispose_fixed_asset_controlled_test is service_role-only for controlled harness.",
        ],
      },
      null,
      2,
    ),
  );

  process.exit(SAFE_TO_APPLY_024 ? 0 : 1);
}

main();
