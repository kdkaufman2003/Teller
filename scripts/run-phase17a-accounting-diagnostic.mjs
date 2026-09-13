#!/usr/bin/env node
/**
 * Phase 17A diagnostic orchestrator — static + optional production read-only.
 */
import { spawnSync } from "node:child_process";

function run(label, cmd, args, env = process.env) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(cmd, args, { stdio: "inherit", env });
  if (result.status !== 0) {
    console.error(`${label} failed`);
    process.exit(result.status ?? 1);
  }
}

run("Phase 17A controlled acceptance (static)", "node", [
  "scripts/run-controlled-phase17a-accounting-integrity.mjs",
]);

if (process.env.TELLER_CONTROLLED_PROD_TEST === "1") {
  run("Phase 17A production read-only diagnostic", "node", [
    "scripts/run-verify-phase17a-production.mjs",
  ]);
} else {
  console.log("\n=== Production diagnostic skipped (set TELLER_CONTROLLED_PROD_TEST=1) ===");
}

console.log("\nPhase 17A diagnostic complete.");
