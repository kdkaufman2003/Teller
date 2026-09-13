#!/usr/bin/env node
/**
 * Phase 17G controlled E2E certification runner.
 * Runs the certification suite twice when mutating shared demo state (default).
 */
import { spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

if (process.env.TELLER_CONTROLLED_PROD_TEST === "1") {
  try {
    loadControlledProdEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

const runs = process.env.TELLER_E2E_RERUN === "0" ? 1 : 2;
let lastStatus = 0;

for (let i = 1; i <= runs; i += 1) {
  console.log(`\n=== Phase 17G E2E certification run ${i}/${runs} ===\n`);
  const result = spawnSync("npx", ["tsx", "scripts/controlled-phase17g-e2e-certification.ts"], {
    stdio: "inherit",
    env: process.env,
  });
  lastStatus = result.status ?? 1;
  if (lastStatus !== 0) {
    console.error(`Run ${i} failed.`);
    process.exit(lastStatus);
  }
}

console.log(
  JSON.stringify(
    {
      PHASE17G_E2E_CERTIFICATION: "PASS",
      PHASE17G_E2E_RERUN: runs === 2 ? "PASS x2" : `PASS x${runs}`,
      runs,
    },
    null,
    2,
  ),
);
process.exit(0);
