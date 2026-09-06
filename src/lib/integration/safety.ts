import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Known production Supabase project — integration tests must never target this ref. */
export const TELLER_PRODUCTION_SUPABASE_PROJECT_REFS = [
  "ypixbxicdecwfafculha",
] as const;

export type IntegrationSafetyResult = {
  projectRef: string;
  urlHost: string;
  allowed: boolean;
  reason: string;
};

export function parseSupabaseProjectRef(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;

  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    const match = host.match(/^([a-z0-9]+)\.supabase\.co$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function isDeniedProductionSupabaseRef(projectRef: string | null | undefined): boolean {
  if (!projectRef) return false;
  return (TELLER_PRODUCTION_SUPABASE_PROJECT_REFS as readonly string[]).includes(projectRef);
}

export function readCurrentGitBranch(): string | null {
  const fromEnv = process.env.TELLER_CURRENT_GIT_BRANCH?.trim();
  if (fromEnv) return fromEnv;

  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Vitest collection may block git exec; read .git/HEAD directly.
    try {
      const headPath = resolve(process.cwd(), ".git/HEAD");
      if (!existsSync(headPath)) return null;
      const head = readFileSync(headPath, "utf8").trim();
      if (head.startsWith("ref: refs/heads/")) {
        return head.slice("ref: refs/heads/".length);
      }
      return null;
    } catch {
      return null;
    }
  }
}

export function evaluateExpectedBranch(input?: {
  expectedBranch?: string | null;
  currentBranch?: string | null;
}): { allowed: boolean; reason: string } {
  const expected = (input?.expectedBranch ?? process.env.TELLER_EXPECTED_BRANCH)?.trim();
  if (!expected) {
    return { allowed: true, reason: "ok" };
  }

  const current = input?.currentBranch?.trim();
  if (!current) {
    return {
      allowed: false,
      reason: "TELLER_EXPECTED_BRANCH is set but current git branch could not be determined",
    };
  }

  if (current !== expected) {
    return {
      allowed: false,
      reason: `Current git branch "${current}" does not match TELLER_EXPECTED_BRANCH="${expected}"`,
    };
  }

  return { allowed: true, reason: "ok" };
}

export function evaluateIntegrationDatabaseSafety(input?: {
  supabaseUrl?: string | null;
  allowIntegrationDb?: string | null;
  runIntegrationTests?: string | null;
  expectedBranch?: string | null;
  currentBranch?: string | null;
}): IntegrationSafetyResult {
  const supabaseUrl = input?.supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const projectRef = parseSupabaseProjectRef(supabaseUrl);
  const urlHost = (() => {
    try {
      return supabaseUrl ? new URL(supabaseUrl.trim()).host : "";
    } catch {
      return "";
    }
  })();

  if (!supabaseUrl?.trim()) {
    return {
      projectRef: projectRef ?? "",
      urlHost,
      allowed: false,
      reason: "NEXT_PUBLIC_SUPABASE_URL is missing",
    };
  }

  if (!projectRef) {
    return {
      projectRef: "",
      urlHost,
      allowed: false,
      reason: "Supabase URL is missing or unparseable project ref",
    };
  }

  if (isDeniedProductionSupabaseRef(projectRef)) {
    return {
      projectRef,
      urlHost,
      allowed: false,
      reason: `Refuses known production Supabase project ref: ${projectRef}`,
    };
  }

  const runIntegrationTests = input?.runIntegrationTests ?? process.env.RUN_INTEGRATION_TESTS;
  if (runIntegrationTests !== "1") {
    return {
      projectRef,
      urlHost,
      allowed: false,
      reason: "RUN_INTEGRATION_TESTS must equal 1",
    };
  }

  const allowIntegrationDb =
    input?.allowIntegrationDb ?? process.env.TELLER_ALLOW_INTEGRATION_DB;
  if (allowIntegrationDb !== "1") {
    return {
      projectRef,
      urlHost,
      allowed: false,
      reason: "TELLER_ALLOW_INTEGRATION_DB must equal 1",
    };
  }

  const branch = evaluateExpectedBranch({
    expectedBranch: input?.expectedBranch,
    currentBranch: input?.currentBranch ?? readCurrentGitBranch(),
  });
  if (!branch.allowed) {
    return {
      projectRef,
      urlHost,
      allowed: false,
      reason: branch.reason,
    };
  }

  return {
    projectRef,
    urlHost,
    allowed: true,
    reason: "ok",
  };
}

export function assertSafeIntegrationDatabase(input?: {
  supabaseUrl?: string | null;
  allowIntegrationDb?: string | null;
  runIntegrationTests?: string | null;
  expectedBranch?: string | null;
  currentBranch?: string | null;
}): IntegrationSafetyResult {
  const result = evaluateIntegrationDatabaseSafety(input);
  if (!result.allowed) {
    throw new Error(`Unsafe integration database: ${result.reason}`);
  }
  return result;
}

export function integrationTestsEnabled(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return false;
  if (process.env.RUN_INTEGRATION_TESTS !== "1") return false;
  if (process.env.TELLER_ALLOW_INTEGRATION_DB !== "1") return false;
  return evaluateIntegrationDatabaseSafety({
    currentBranch: readCurrentGitBranch(),
  }).allowed;
}
