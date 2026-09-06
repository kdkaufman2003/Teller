#!/usr/bin/env node
/**
 * Run integration tests using ONLY .env.integration (never .env.local).
 * Prints DB_INTEGRATION_VERIFIED for deployment gates (skipped tests do not count as pass).
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadIntegrationEnv } from "./load-integration-env.mjs";

const PROBE_FILE = resolve(process.cwd(), "artifacts/integration-db-probe.json");
const RESULTS_FILE = resolve(process.cwd(), "artifacts/integration-test-results.json");

try {
  const loaded = loadIntegrationEnv({ required: true });
  if (!loaded) process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

try {
  process.env.TELLER_CURRENT_GIT_BRANCH = execSync("git rev-parse --abbrev-ref HEAD", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // Vitest workers cannot always invoke git; branch guard uses this when set.
}

const result = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "--config",
    "vitest.integration.config.ts",
    "--reporter=default",
    "--reporter=json",
    "--outputFile",
    RESULTS_FILE,
  ],
  { stdio: "inherit", env: process.env },
);

function integrationDbReachable() {
  if (!existsSync(PROBE_FILE)) return false;
  try {
    const probe = JSON.parse(readFileSync(PROBE_FILE, "utf8"));
    return probe.reachable === true;
  } catch {
    return false;
  }
}

function dbSuiteExecuted(report) {
  const dbFileFragments = [
    "phase5-banking-schema",
    "phase4-",
    "phase3-financial",
    "phase2-financial",
    "financial.test.ts",
  ];
  for (const file of report.testResults ?? []) {
    const name = String(file.name);
    if (!dbFileFragments.some((fragment) => name.includes(fragment))) continue;
    for (const test of file.assertionResults ?? []) {
      if (test.status === "passed" || test.status === "failed") return true;
    }
  }
  for (const file of report.testResults ?? []) {
    if (!String(file.name).includes("hfac-webhook")) continue;
    for (const test of file.assertionResults ?? []) {
      const titles = test.ancestorTitles ?? [];
      if (titles.includes("HFAC integration mapping") && test.status !== "skipped") return true;
    }
  }
  return false;
}

function countIntegrationTests() {
  if (!existsSync(RESULTS_FILE)) return { passed: 0, failed: 0, skipped: 0, dbSuiteRan: false };
  try {
    const report = JSON.parse(readFileSync(RESULTS_FILE, "utf8"));
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    for (const file of report.testResults ?? []) {
      if (!String(file.name).includes("/integration/")) continue;
      for (const test of file.assertionResults ?? []) {
        if (test.status === "passed") passed += 1;
        else if (test.status === "failed") failed += 1;
        else if (test.status === "skipped") skipped += 1;
      }
    }
    return { passed, failed, skipped, dbSuiteRan: dbSuiteExecuted(report) };
  } catch {
    return { passed: 0, failed: 0, skipped: 0, dbSuiteRan: false };
  }
}

const dbReachable = integrationDbReachable();
const counts = countIntegrationTests();
const dbIntegrationVerified = dbReachable && counts.dbSuiteRan && counts.failed === 0;

console.log("");
console.log("=== Integration deployment gate ===");
console.log(`DB_INTEGRATION_VERIFIED=${dbIntegrationVerified}`);
console.log(
  JSON.stringify(
    {
      dbReachable,
      dbSuiteRan: counts.dbSuiteRan,
      integrationTestsPassed: counts.passed,
      integrationTestsFailed: counts.failed,
      integrationTestsSkipped: counts.skipped,
      note: "Skipped integration tests do not satisfy production migration verification.",
    },
    null,
    2,
  ),
);

process.exit(result.status ?? 1);

