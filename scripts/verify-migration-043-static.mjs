#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const patchPath = join(root, "supabase/patches/043_phase16c_accounting_state_entity.sql");
const issues = [];

if (!existsSync(patchPath)) {
  issues.push("Missing patch: supabase/patches/043_phase16c_accounting_state_entity.sql");
} else {
  const sql = readFileSync(patchPath, "utf8");
  for (const token of [
    "teller_get_accounting_state",
    "p_legal_entity_id uuid default null",
    "on conflict (organization_id, legal_entity_id)",
    "teller_journal_entries_bump_accounting_version",
    "NEW.legal_entity_id",
    "teller_close_state_bump_from_checklist",
    "teller_close_state_bump_from_reconciliation",
  ]) {
    if (!sql.includes(token)) issues.push(`043 patch missing: ${token}`);
  }
  if (/on conflict \(organization_id\) do update/i.test(sql)) {
    issues.push("043 patch must not use org-only ON CONFLICT");
  }
}

console.log(
  JSON.stringify(
    {
      MIGRATION_043_PATCH_STATIC_VERIFY: issues.length ? "FAIL" : "PASS",
      issues,
      manualPatchRequired: true,
      patchFile: "supabase/patches/043_phase16c_accounting_state_entity.sql",
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
