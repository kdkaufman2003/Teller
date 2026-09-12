#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const rerun = process.argv.includes("--rerun-2");

try {
  loadControlledProdEnv();
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");
  }
  if (!process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim()) {
    throw new Error(
      "TELLER_PHASE16_DEMO_ORG_ID missing — add to .env.controlled-prod.local or run npm run setup:phase16-demo-org",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

function runOnce(label) {
  const result = spawnSync("npx", ["tsx", "scripts/controlled-phase16j-final-acceptance.ts"], {
    stdio: "inherit",
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) {
    console.error(`${label} failed`);
    process.exit(result.status ?? 1);
  }
}

runOnce("PHASE16J_ACCEPTANCE_RERUN_1");
if (rerun) {
  runOnce("PHASE16J_ACCEPTANCE_RERUN_2");
}

console.log(
  JSON.stringify(
    {
      PHASE16J_ACCEPTANCE_RERUN_1: "PASS",
      PHASE16J_ACCEPTANCE_RERUN_2: rerun ? "PASS" : "SKIPPED",
    },
    null,
    2,
  ),
);
