import path from "node:path";
import { execSync } from "node:child_process";
import { defineConfig } from "vitest/config";

function readGitBranchForIntegrationTests(): string {
  const fromEnv = process.env.TELLER_CURRENT_GIT_BRANCH?.trim();
  if (fromEnv) return fromEnv;

  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/test/integration/**/*.test.ts"],
    setupFiles: ["src/test/integration/setup.ts"],
    globalSetup: ["src/test/integration/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: {
      TELLER_CURRENT_GIT_BRANCH: readGitBranchForIntegrationTests(),
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
