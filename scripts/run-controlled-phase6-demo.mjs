#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

try {
  loadControlledProdEnv();
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");
  }
  if (!process.env.TELLER_PHASE6_DEMO_ORG_ID?.trim()) {
    throw new Error("TELLER_PHASE6_DEMO_ORG_ID missing — run npm run setup:phase6-demo-org first");
  }
  const orgId = process.env.TELLER_PHASE6_DEMO_ORG_ID.trim();
  if (orgId === "812be00d-3084-4227-ac71-ccbd22e4172c") {
    throw new Error("Refusing HFAC organization");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const result = spawnSync("npx", ["tsx", "scripts/controlled-phase6-demo-runner.ts"], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
