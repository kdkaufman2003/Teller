#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

loadControlledProdEnv();

const accept = spawnSync("npx", ["tsx", "scripts/controlled-phase15-db-acceptance.ts"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(accept.status ?? 1);
