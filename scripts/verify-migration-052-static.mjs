#!/usr/bin/env node
/** Static verification for patch 052 — no DB connection. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];
const patchPath = join(root, "supabase/patches/052_phase17c_reliability_hardening.sql");

if (!existsSync(patchPath)) {
  console.log(
    JSON.stringify({ PATCH_052_STATIC_VERIFY: "FAIL", issues: ["Missing patch file"] }, null, 2),
  );
  process.exit(1);
}

const sql = readFileSync(patchPath, "utf8");

const required = [
  "processing_status",
  "teller_payments",
  "idempotency_key",
  "teller_payment_allocation_capacity_check",
  "teller_document_allocation_capacity_check",
  "teller_phase17c_reliability_probe",
  "grant execute on function public.teller_phase17c_reliability_probe",
  "set search_path = public",
];

const forbidden = [
  /disable row level security/i,
  /\bupdate\b.*teller_journal_entries/i,
  /\bdelete\b.*teller_journal_entries/i,
  /\bdelete\b.*teller_payments/i,
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
      PATCH_052_STATIC_VERIFY: issues.length ? "FAIL" : "PASS",
      issues,
      manualPatchRequired: true,
      patchFile: "supabase/patches/052_phase17c_reliability_hardening.sql",
      automaticPatchApplication: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
