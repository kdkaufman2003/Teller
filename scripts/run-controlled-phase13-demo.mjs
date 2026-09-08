#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const demo = spawnSync("npx", ["tsx", "scripts/controlled-phase13-demo-runner.ts"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(demo.status ?? 1);
