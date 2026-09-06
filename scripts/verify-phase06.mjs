#!/usr/bin/env node
/**
 * Phase 0.6 operational gate — runs migration verify, legacy audit, HFAC report,
 * and (optionally) integration tests against live Supabase.
 *
 * Usage:
 *   npm run verify:phase06
 *   RUN_INTEGRATION_TESTS=1 npm run verify:phase06
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvLocal } from "./load-env.mjs";

const root = resolve(import.meta.dirname, "..");
const hasEnvLocal = loadEnvLocal() || existsSync(resolve(root, ".env.local"));

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  return value;
}

function runStep(label, command, args, extraEnv = {}) {
  console.log(`\n=== ${label} ===\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    shell: false,
  });
  return result.status ?? 1;
}

async function main() {
  const url = required("NEXT_PUBLIC_SUPABASE_URL");
  const key = required("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    console.error(
      hasEnvLocal
        ? "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local"
        : "Create .env.local from .env.example with Supabase credentials, then re-run.",
    );
    process.exit(1);
  }

  const results = [];
  const steps = [
    ["Migration verification", "node", ["scripts/verify-migrations.mjs"]],
    ["Legacy payment audit", "npx", ["tsx", "scripts/legacy-payment-audit.ts"]],
    ["HFAC integration report", "node", ["scripts/hfac-integration-report.mjs"]],
  ];

  if (process.env.RUN_INTEGRATION_TESTS === "1") {
    steps.push([
      "Integration tests",
      "npx",
      ["vitest", "run", "--config", "vitest.integration.config.ts"],
      { RUN_INTEGRATION_TESTS: "1" },
    ]);
  }

  for (const [label, command, args, extraEnv = {}] of steps) {
    const code = runStep(label, command, args, extraEnv);
    results.push({ label, pass: code === 0, exitCode: code });
    if (code !== 0) break;
  }

  console.log("\n=== Phase 0.6 gate summary ===\n");
  console.log(JSON.stringify({ allPass: results.every((r) => r.pass), results }, null, 2));

  if (!results.every((r) => r.pass)) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
