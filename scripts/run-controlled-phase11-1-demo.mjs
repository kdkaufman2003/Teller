#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["tsx", "scripts/controlled-phase11-1-demo-runner.ts"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
