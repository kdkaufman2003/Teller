#!/usr/bin/env node
/** Static verify for Phase 15D tax line org guard patch. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const path = join(process.cwd(), "supabase/patches/036_phase15d_tax_line_org_guard.sql");
const issues = [];

if (!existsSync(path)) {
  issues.push("Missing patch file");
} else {
  const sql = readFileSync(path, "utf8");
  if (!/teller_document_lines l\s*\n\s*join public\.teller_documents d/i.test(sql)) {
    issues.push("Patch must join document_lines to documents for org resolution");
  }
  if (/teller_document_lines where id = new\.line_id/i.test(sql) && /organization_id into line_org from public\.teller_document_lines/i.test(sql)) {
    issues.push("Patch must not select organization_id directly from teller_document_lines");
  }
  if (!/teller_guard_tax_transaction_org/.test(sql)) {
    issues.push("Patch must replace teller_guard_tax_transaction_org");
  }
}

console.log(JSON.stringify({ PATCH_036_VERIFY: issues.length === 0 ? "PASS" : "FAIL", issues }, null, 2));
process.exit(issues.length === 0 ? 0 : 1);
