#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const result = spawnSync("node", ["scripts/verify-phase17d-production.mjs"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
