#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

loadControlledProdEnv();
const orgId = process.env.TELLER_PHASE10_DEMO_ORG_ID?.trim();
if (!orgId) {
  console.error("TELLER_PHASE10_DEMO_ORG_ID missing — run npm run setup:phase10-demo-org first");
  process.exit(1);
}

const result = spawnSync("npx", ["tsx", "scripts/controlled-phase10-demo-runner.ts"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
