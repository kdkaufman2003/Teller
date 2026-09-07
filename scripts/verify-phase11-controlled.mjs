#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const issues = [];

const migration = resolve(ROOT, "supabase/migrations/027_phase11_subledger_automation.sql");
const runner = resolve(ROOT, "scripts/controlled-phase11-demo-runner.ts");
const tests = resolve(ROOT, "src/lib/accounting/phase11.test.ts");

if (!existsSync(migration)) issues.push("Missing migration 027");
if (!existsSync(runner)) issues.push("Missing controlled-phase11-demo-runner.ts");
if (!existsSync(tests)) issues.push("Missing phase11.test.ts");

const runnerSrc = existsSync(runner) ? readFileSync(runner, "utf8") : "";
if (!runnerSrc.includes("PHASE11_CONTROLLED_MATRIX_SIZE = 105")) {
  issues.push("Runner matrix size must be 105");
}
if (!runnerSrc.includes("TELLER_HFAC_ORG_ID")) {
  issues.push("Runner must reference HFAC org id for hard refusal");
}
if (/matrix placeholder|Reserved scenario slot|detail: "Reserved"/.test(runnerSrc)) {
  issues.push("Runner contains placeholder scenarios");
}

console.log(JSON.stringify({ ok: issues.length === 0, issues }, null, 2));
process.exit(issues.length ? 1 : 0);
