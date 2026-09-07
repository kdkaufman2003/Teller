#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const issues = [];

if (!existsSync(resolve(ROOT, "supabase/migrations/026_phase10_financial_reporting.sql"))) {
  issues.push("Missing migration 026");
}
if (!existsSync(resolve(ROOT, "scripts/controlled-phase10-demo-runner.ts"))) {
  issues.push("Missing controlled-phase10-demo-runner.ts");
}
if (!existsSync(resolve(ROOT, "src/lib/accounting/phase10.test.ts"))) {
  issues.push("Missing phase10.test.ts");
}

const runner = readFileSync(resolve(ROOT, "scripts/controlled-phase10-demo-runner.ts"), "utf8");
if (!runner.includes("PHASE10_CONTROLLED_MATRIX_SIZE = 110")) {
  issues.push("Runner matrix size must be 110");
}
if (!runner.includes("TELLER_HFAC_ORG_ID")) {
  issues.push("Runner must reference HFAC org id for hard refusal");
}
if (!runner.includes("CONTROLLED_PHASE10_DEMO_ORG_NAME")) {
  issues.push("Runner must use Phase 10 demo org name");
}
if (/matrix placeholder|Reserved scenario slot|detail: "Reserved"/.test(runner)) {
  issues.push("Runner contains placeholder or reserved scenario slots");
}
if (runner.includes("skipped: true") && runner.includes("pass: true")) {
  issues.push("Runner must not mark skipped accounting scenarios as pass");
}

console.log(JSON.stringify({ ok: issues.length === 0, issues }, null, 2));
process.exit(issues.length ? 1 : 0);
