import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertSafeIntegrationDatabase, readCurrentGitBranch } from "@/lib/integration/safety";

function clearSupabaseEnvVars() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.RUN_INTEGRATION_TESTS;
  delete process.env.TELLER_ALLOW_INTEGRATION_DB;
  delete process.env.TELLER_EXPECTED_BRANCH;
}

function loadIntegrationEnvFile() {
  clearSupabaseEnvVars();
  const path = resolve(process.cwd(), ".env.integration");
  if (!existsSync(path)) return false;

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

  return true;
}

const loaded = loadIntegrationEnvFile();
if (loaded) {
  try {
    assertSafeIntegrationDatabase({ currentBranch: readCurrentGitBranch() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Integration setup blocked: ${message}`);
    delete process.env.RUN_INTEGRATION_TESTS;
    delete process.env.TELLER_ALLOW_INTEGRATION_DB;
  }
}
