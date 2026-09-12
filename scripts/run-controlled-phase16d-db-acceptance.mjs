#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

try {
  loadControlledProdEnv();
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");
  }
  if (!process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim()) {
    throw new Error("TELLER_PHASE16_DEMO_ORG_ID missing — run npm run setup:phase16-demo-org");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const result = spawnSync("npx", ["tsx", "scripts/controlled-phase16d-db-acceptance.ts"], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
