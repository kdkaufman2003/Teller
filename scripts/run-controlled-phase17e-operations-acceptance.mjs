#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

try {
  loadControlledProdEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const result = spawnSync("npx", ["tsx", "scripts/controlled-phase17e-operations-acceptance.ts"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
