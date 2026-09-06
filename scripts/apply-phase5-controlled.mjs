#!/usr/bin/env node
/** Apply migrations 018 → 019 → 020 on controlled production database. */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const STEPS = [
  "apply-migration-018-controlled.mjs",
  "apply-migration-019-controlled.mjs",
  "apply-migration-020-controlled.mjs",
];

function main() {
  loadControlledProdEnv();

  for (const step of STEPS) {
    console.log(`\n=== ${step} ===`);
    const result = spawnSync("node", [resolve(process.cwd(), "scripts", step)], {
      stdio: "inherit",
      env: process.env,
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }

  console.log(JSON.stringify({ ok: true, applied: ["018", "019", "020"] }, null, 2));
}

main();
