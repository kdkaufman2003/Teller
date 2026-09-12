#!/usr/bin/env node
/** Static verification for patch 048 — no DB connection. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const issues = [];
const patchPath = join(root, "supabase/patches/048_phase16j_books_closed_through_overload_fix.sql");

if (!existsSync(patchPath)) {
  console.log(
    JSON.stringify({ PATCH_048_STATIC_VERIFY: "FAIL", issues: ["Missing patch file"] }, null, 2),
  );
  process.exit(1);
}

const sql = readFileSync(patchPath, "utf8");

const required = [
  "drop function if exists public.teller_books_closed_through(uuid)",
  "create or replace function public.teller_books_closed_through",
  "p_legal_entity_id uuid default null",
  "teller_default_legal_entity_id(p_org)",
  "teller_phase16j_books_closed_probe",
  "grant execute on function public.teller_books_closed_through(uuid, uuid)",
];

for (const token of required) {
  if (!sql.toLowerCase().includes(token.toLowerCase())) {
    issues.push(`Missing: ${token}`);
  }
}

if (/disable row level security/i.test(sql)) issues.push("Must not disable RLS");

console.log(
  JSON.stringify(
    {
      PATCH_048_STATIC_VERIFY: issues.length ? "FAIL" : "PASS",
      issues,
      manualPatchRequired: true,
      patchFile: "supabase/patches/048_phase16j_books_closed_through_overload_fix.sql",
      automaticPatchApplication: false,
    },
    null,
    2,
  ),
);

process.exit(issues.length ? 1 : 0);
