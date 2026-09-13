#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["tsx", "scripts/controlled-phase17f-ux-acceptance.ts"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
