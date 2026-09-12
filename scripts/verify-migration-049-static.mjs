#!/usr/bin/env node
/** Static verification for patch 049 — no DB connection. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];
const patchPath = join(root, "supabase/patches/049_phase16j_legacy_posting_entity_fix.sql");

if (!existsSync(patchPath)) {
  console.log(JSON.stringify({ PATCH_049_STATIC_VERIFY: "FAIL", issues: ["Missing patch file"] }, null, 2));
  process.exit(1);
}

const sql = readFileSync(patchPath, "utf8").toLowerCase();

const required = [
  "drop function if exists public.teller_post_journal(uuid, date, text, text, uuid, uuid, jsonb)",
  "teller_default_legal_entity_id(p_organization_id)",
  "teller_default_insert_legal_entity",
  "teller_documents_default_legal_entity",
  "teller_adjusting_journal_default_legal_entity",
  "teller_close_checklist_default_legal_entity",
  "teller_phase16j_legacy_posting_probe",
];

for (const token of required) {
  if (!sql.includes(token)) issues.push(`Missing: ${token}`);
}

if (/disable row level security/i.test(sql)) issues.push("Must not disable RLS");

console.log(
  JSON.stringify(
    {
      PATCH_049_STATIC_VERIFY: issues.length ? "FAIL" : "PASS",
      issues,
      manualPatchRequired: true,
      patchFile: "supabase/patches/049_phase16j_legacy_posting_entity_fix.sql",
      automaticPatchApplication: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
