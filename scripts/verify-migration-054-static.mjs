#!/usr/bin/env node
/** Static verification for patch 054 — no DB connection. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];
const patchPath = join(root, "supabase/patches/054_phase17e_operational_controls.sql");

if (!existsSync(patchPath)) {
  console.log(
    JSON.stringify({ PATCH_054_STATIC_VERIFY: "FAIL", issues: ["Missing patch file"] }, null, 2),
  );
  process.exit(1);
}

const sql = readFileSync(patchPath, "utf8");

const required = [
  "teller_audit_append_only_guard",
  "teller_audit_events_no_update",
  "teller_phase17e_operations_probe",
  "teller_hfac_webhook_events_status_received_idx",
  "teller_hfac_webhook_ops_snapshot",
  "grant select on public.teller_hfac_webhook_events",
  "revoke update on public.teller_audit_events",
  "grant execute on function public.teller_phase17e_operations_probe",
];

const forbidden = [
  /disable row level security/i,
  /delete from public.teller_audit_events/i,
  /truncate/i,
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
      PATCH_054_STATIC_VERIFY: issues.length ? "FAIL" : "PASS",
      issues,
      manualPatchRequired: true,
      patchFile: "supabase/patches/054_phase17e_operational_controls.sql",
      automaticPatchApplication: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
