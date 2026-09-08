#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

function check() {
  const issues = [];
  const m031 = resolve(ROOT, "supabase/migrations/031_phase13_inventory.sql");
  if (!existsSync(m031)) issues.push("Missing migration 031");
  if (!existsSync(resolve(ROOT, "scripts/controlled-phase13-demo-runner.ts"))) issues.push("Missing demo runner");
  if (!existsSync(resolve(ROOT, "src/lib/accounting/phase13.test.ts"))) issues.push("Missing phase13 tests");
  if (!existsSync(resolve(ROOT, "src/lib/accounting/inventory/index.ts"))) issues.push("Missing inventory module");
  return issues;
}

const issues = check();
console.log(JSON.stringify({ PHASE13_CONTROLLED_VERIFY: issues.length ? "FAIL" : "PASS", issues }, null, 2));
process.exit(issues.length ? 1 : 0);
