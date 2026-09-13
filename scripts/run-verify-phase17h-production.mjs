#!/usr/bin/env node
import { spawnSync } from "node:child_process";

if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
  console.error("Set TELLER_CONTROLLED_PROD_TEST=1 to run production verification.");
  process.exit(1);
}

const result = spawnSync("node", ["scripts/verify-phase17h-production.mjs"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
