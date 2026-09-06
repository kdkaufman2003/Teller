/**
 * Load .env.local + optional .env.controlled-prod.local for controlled production tests.
 * Requires TELLER_CONTROLLED_PROD_TEST=1 and blocks destructive integration flags.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PRODUCTION_REF = "ypixbxicdecwfafculha";
const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";

function loadFile(filename) {
  const path = resolve(process.cwd(), filename);
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

export function loadControlledProdEnv(options = {}) {
  const { requireTestOrg = false } = options;

  if (process.env.RUN_INTEGRATION_TESTS === "1" || process.env.TELLER_ALLOW_INTEGRATION_DB === "1") {
    throw new Error(
      "Controlled prod test refuses RUN_INTEGRATION_TESTS / TELLER_ALLOW_INTEGRATION_DB",
    );
  }

  loadFile(".env.local");
  loadFile(".env.controlled-prod.local");

  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");
  }

  const ref = parseProjectRef(process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (ref !== PRODUCTION_REF) {
    throw new Error(`Expected production ref ${PRODUCTION_REF}, got ${ref ?? "missing"}`);
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  }

  if (requireTestOrg) {
    const testOrg = process.env.TELLER_CONTROLLED_TEST_ORG_ID?.trim();
    if (!testOrg) {
      throw new Error("TELLER_CONTROLLED_TEST_ORG_ID is required for test mutations");
    }
    if (testOrg === HFAC_ORG_ID) {
      throw new Error("TELLER_CONTROLLED_TEST_ORG_ID must not be Hassle Free AC");
    }
  }

  return {
    projectRef: ref,
    urlHost: new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host,
    hfacOrgId: HFAC_ORG_ID,
    testOrgId: process.env.TELLER_CONTROLLED_TEST_ORG_ID?.trim() ?? null,
    foreignOrgId: process.env.TELLER_CONTROLLED_FOREIGN_ORG_ID?.trim() ?? null,
    hasDbUrl: Boolean(process.env.SUPABASE_DB_URL?.trim()),
  };
}

if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, "/") ?? "\0")) {
  try {
    const info = loadControlledProdEnv();
    console.log(JSON.stringify({ ok: true, ...info }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
