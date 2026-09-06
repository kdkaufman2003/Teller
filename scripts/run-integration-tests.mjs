#!/usr/bin/env node
/**
 * Run integration tests using ONLY .env.integration (never .env.local).
 */
import { execSync, spawnSync } from "node:child_process";
import { loadIntegrationEnv } from "./load-integration-env.mjs";

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
  ["vitest", "run", "--config", "vitest.integration.config.ts"],
  { stdio: "inherit", env: process.env },
);

process.exit(result.status ?? 1);
