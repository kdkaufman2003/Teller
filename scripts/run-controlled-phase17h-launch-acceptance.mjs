#!/usr/bin/env node
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

const runs = process.env.TELLER_17H_RERUN === "0" ? 1 : 2;
for (let i = 1; i <= runs; i += 1) {
  console.log(`\n=== Phase 17H launch acceptance run ${i}/${runs} ===\n`);
  const result = spawnSync("npx", ["tsx", "scripts/controlled-phase17h-launch-acceptance.ts"], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(
  JSON.stringify(
    {
      PHASE17H_CONTROLLED_ACCEPTANCE: "PASS",
      PHASE17H_ACCEPTANCE_RERUN: runs === 2 ? "PASS x2" : `PASS x${runs}`,
    },
    null,
    2,
  ),
);
