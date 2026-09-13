#!/usr/bin/env node
/** Static verification for patch 053 — no DB connection. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];
const patchPath = join(root, "supabase/patches/053_phase17d_performance_hardening.sql");

if (!existsSync(patchPath)) {
  console.log(JSON.stringify({ PATCH_053_STATIC_VERIFY: "FAIL", issues: ["Missing patch file"] }, null, 2));
  process.exit(1);
}

const sql = readFileSync(patchPath, "utf8");
const required = [
  "teller_journal_entries_reverses_entry_idx",
  "teller_documents_org_party_kind_date_idx",
  "teller_payment_allocations_payment_id_idx",
  "teller_bank_transactions_org_status_date_idx",
  "teller_phase17d_performance_probe",
  "create index if not exists",
];

const forbidden = [
  /disable row level security/i,
  /\bupdate\b.*teller_journal/i,
  /\bdelete\b.*teller_/i,
  /drop index/i,
];

for (const token of required) {
  if (!sql.includes(token)) issues.push(`Missing: ${token}`);
}
for (const pattern of forbidden) {
  if (pattern.test(sql)) issues.push(`Forbidden: ${pattern}`);
}

console.log(
  JSON.stringify(
    {
      PATCH_053_STATIC_VERIFY: issues.length ? "FAIL" : "PASS",
      issues,
      manualPatchRequired: true,
      patchFile: "supabase/patches/053_phase17d_performance_hardening.sql",
      automaticPatchApplication: false,
    },
    null,
    2,
  ),
);
process.exit(issues.length ? 1 : 0);
