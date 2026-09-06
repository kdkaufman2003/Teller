#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

try {
  loadControlledProdEnv();
  if (!process.env.TELLER_PHASE5_DEMO_ORG_ID?.trim()) {
    throw new Error("TELLER_PHASE5_DEMO_ORG_ID missing — run npm run setup:phase5-demo-org first");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const result = spawnSync("npx", ["tsx", "scripts/controlled-phase5-demo-runner.ts"], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
