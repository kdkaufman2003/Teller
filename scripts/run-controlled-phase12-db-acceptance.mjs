#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

loadControlledProdEnv();

const verify = spawnSync("node", ["scripts/verify-migration-029-controlled.mjs"], {
  stdio: "inherit",
  env: process.env,
});
if (verify.status !== 0) {
  console.error(JSON.stringify({ MIGRATION_029_VERIFIED: false, stopped: true }, null, 2));
  process.exit(1);
}

const verify030 = spawnSync("node", ["scripts/verify-migration-030-controlled.mjs"], {
  stdio: "inherit",
  env: process.env,
});
if (verify030.status !== 0) {
  console.error(
    JSON.stringify(
      {
        MIGRATION_030_VERIFIED: false,
        stopped: true,
        hint: "Apply supabase/migrations/030_phase12_payroll_atomic_rpc.sql manually, then re-run acceptance",
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

const acceptance = spawnSync("npx", ["tsx", "scripts/controlled-phase12-db-acceptance.ts"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(acceptance.status ?? 1);
