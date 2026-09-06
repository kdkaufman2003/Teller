#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

try {
  loadControlledProdEnv({ requireTestOrg: true });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const result = spawnSync("npx", ["tsx", "scripts/controlled-phase4-runner.ts"], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
