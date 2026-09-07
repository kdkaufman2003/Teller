#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

loadControlledProdEnv();
const result = spawnSync("npx", ["tsx", "scripts/controlled-phase11-db-acceptance.ts"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
