#!/usr/bin/env node
/** Static verification for patch 051 — no DB connection. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];
const patchPath = join(root, "supabase/patches/051_phase17b_security_hardening.sql");

if (!existsSync(patchPath)) {
  console.log(
    JSON.stringify({ PATCH_051_STATIC_VERIFY: "FAIL", issues: ["Missing patch file"] }, null, 2),
  );
  process.exit(1);
}

const sql = readFileSync(patchPath, "utf8");

const required = [
  'drop policy if exists "teller entity journal entries insert"',
  'drop policy if exists "teller entity journal lines insert"',
  "teller_phase17b_journal_insert_blocked",
  "set search_path = public",
  "grant execute on function public.teller_phase17b_journal_insert_blocked",
];

const forbidden = [
  /disable row level security/i,
  /\bupdate\b.*teller_journal_entries/i,
  /\bdelete\b.*teller_journal_entries/i,
];

for (const token of required) {
  if (!sql.includes(token)) issues.push(`Missing: ${token}`);
}

for (const pattern of forbidden) {
  if (pattern.test(sql)) issues.push(`Forbidden pattern: ${pattern}`);
}

console.log(
  JSON.stringify(
    {
      PATCH_051_STATIC_VERIFY: issues.length ? "FAIL" : "PASS",
      issues,
      manualPatchRequired: true,
      patchFile: "supabase/patches/051_phase17b_security_hardening.sql",
      automaticPatchApplication: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
