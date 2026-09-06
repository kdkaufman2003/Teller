/**
 * Load ONLY .env.integration for isolated Supabase integration work.
 * Does not read .env.local. Clears Supabase vars first to avoid shell/production leakage.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { execSync } from "node:child_process";

const PRODUCTION_REFS = ["ypixbxicdecwfafculha"];

function parseProjectRef(url) {
  if (!url?.trim()) return null;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    const match = host.match(/^([a-z0-9]+)\.supabase\.co$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function currentGitBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function assertSafeIntegrationEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const ref = parseProjectRef(url);

  if (!url) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL. Create .env.integration with your isolated Supabase project.",
    );
  }
  if (!ref) {
    throw new Error("Could not parse Supabase project ref from NEXT_PUBLIC_SUPABASE_URL.");
  }
  if (PRODUCTION_REFS.includes(ref)) {
    throw new Error(
      `Refusing known production Supabase project ref (${ref}). Use a separate isolated project in .env.integration.`,
    );
  }
  if (process.env.RUN_INTEGRATION_TESTS !== "1") {
    throw new Error("RUN_INTEGRATION_TESTS must equal 1 in .env.integration.");
  }
  if (process.env.TELLER_ALLOW_INTEGRATION_DB !== "1") {
    throw new Error("TELLER_ALLOW_INTEGRATION_DB must equal 1 in .env.integration.");
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in .env.integration.");
  }

  const expectedBranch = process.env.TELLER_EXPECTED_BRANCH?.trim();
  if (expectedBranch) {
    const currentBranch = currentGitBranch();
    if (!currentBranch) {
      throw new Error(
        "TELLER_EXPECTED_BRANCH is set but current git branch could not be determined.",
      );
    }
    if (currentBranch !== expectedBranch) {
      throw new Error(
        `Refusing integration tests on branch "${currentBranch}" (expected "${expectedBranch}").`,
      );
    }
  }
}

export function clearSupabaseEnvVars() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.RUN_INTEGRATION_TESTS;
  delete process.env.TELLER_ALLOW_INTEGRATION_DB;
  delete process.env.SUPABASE_DB_URL;
  delete process.env.TELLER_EXPECTED_BRANCH;
}

export function loadIntegrationEnv(options = {}) {
  const { required = true } = options;
  clearSupabaseEnvVars();

  const path = resolve(process.cwd(), ".env.integration");
  if (!existsSync(path)) {
    if (required) {
      throw new Error(
        "Missing .env.integration. Copy .env.integration.example and point it at a disposable Supabase project.",
      );
    }
    return false;
  }

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }

  assertSafeIntegrationEnv();
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    loadIntegrationEnv({ required: true });
    const ref = parseProjectRef(process.env.NEXT_PUBLIC_SUPABASE_URL);
    console.log(
      JSON.stringify(
        {
          ok: true,
          projectRef: ref,
          urlHost: new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host,
          productionRefBlocked: PRODUCTION_REFS.includes(ref),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
