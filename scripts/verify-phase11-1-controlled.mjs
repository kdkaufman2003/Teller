#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const test = spawnSync("npm", ["test"], { stdio: "inherit", env: process.env });
if (test.status !== 0) process.exit(test.status ?? 1);

const demo = spawnSync("node", ["scripts/run-controlled-phase11-1-demo.mjs"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(demo.status ?? 1);
