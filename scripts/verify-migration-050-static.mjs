#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const patchPath = join(process.cwd(), "supabase/patches/050_phase16j_payments_entity_default.sql");
const issues = [];

if (!existsSync(patchPath)) issues.push("Missing patch file");
else {
  const sql = readFileSync(patchPath, "utf8").toLowerCase();
  if (!sql.includes("teller_payments_default_legal_entity")) issues.push("Missing payments trigger");
  if (!sql.includes("teller_default_insert_legal_entity")) issues.push("Missing trigger function reference");
}

console.log(
  JSON.stringify(
    {
      PATCH_050_STATIC_VERIFY: issues.length ? "FAIL" : "PASS",
      issues,
      patchFile: "supabase/patches/050_phase16j_payments_entity_default.sql",
      manualPatchRequired: true,
    },
    null,
    2,
  ),
);
process.exit(issues.length ? 1 : 0);
