#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

loadControlledProdEnv();

const verify = spawnSync("node", ["scripts/verify-migration-028-controlled.mjs"], {
  stdio: "inherit",
  env: process.env,
});
if (verify.status !== 0) {
  console.error(JSON.stringify({ MIGRATION_028_VERIFIED: false, stopped: true }, null, 2));
  process.exit(1);
}

const acceptance = spawnSync("npx", ["tsx", "scripts/controlled-phase11-1-db-acceptance.ts"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(acceptance.status ?? 1);
