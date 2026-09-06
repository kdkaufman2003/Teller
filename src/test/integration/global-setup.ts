/**
 * Probes isolated Supabase before integration tests run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const PROBE_FILE = resolve(process.cwd(), "artifacts/integration-db-probe.json");

export async function setup() {
  const envPath = resolve(process.cwd(), ".env.integration");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  let reachable = false;
  let detail = "missing env";

  if (url && key) {
    try {
      const supabase = createClient(url, key, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error } = await supabase
        .from("teller_organizations")
        .select("id", { count: "exact", head: true });
      reachable = !error;
      detail = error?.message ?? "ok";
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
  }

  mkdirSync(resolve(process.cwd(), "artifacts"), { recursive: true });
  writeFileSync(
    PROBE_FILE,
    JSON.stringify({ reachable, detail, urlHost: url ? new URL(url).host : null }, null, 2),
  );

  if (!reachable) {
    console.warn(`Integration DB unreachable (${detail}) — integration tests will be skipped.`);
  }
}

export async function teardown() {}
