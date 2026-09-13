#!/usr/bin/env node
/**
 * Repository secret hygiene scan — reports file/line only, never secret values.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "artifacts",
  "coverage",
  ".vercel",
]);
const SKIP_FILES = new Set([".env", ".env.local", ".env.controlled-prod.local"]);

const PATTERNS = [
  { id: "supabase_service_role", re: /SUPABASE_SERVICE_ROLE_KEY\s*=\s*['"]?[a-zA-Z0-9_-]{20,}/ },
  { id: "jwt_like", re: /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/ },
  { id: "hfac_webhook_secret", re: /TELLER_HFAC_WEBHOOK_SECRET\s*=\s*['"]?[a-zA-Z0-9+/=]{16,}/ },
  { id: "generic_api_key", re: /(?:api[_-]?key|secret[_-]?key)\s*[:=]\s*['"][a-zA-Z0-9_-]{24,}['"]/i },
  { id: "private_key_block", re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
];

const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    if (SKIP_DIRS.has(name)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    if (SKIP_FILES.has(name) || name.endsWith(".pem")) continue;
    if (name === ".env.example" || name === ".env.integration.example" || name === ".env.controlled-prod.example") {
      continue;
    }
    if (!/\.(ts|tsx|js|mjs|json|md|sql)$/.test(name)) continue;
    const content = readFileSync(full, "utf8");
    for (const pattern of PATTERNS) {
      if (pattern.re.test(content)) {
        hits.push({ file: rel, pattern: pattern.id });
      }
    }
  }
}

walk(ROOT);

const controlledProdCommitted = existsSync(join(ROOT, ".env.controlled-prod.local"))
  ? !readFileSync(join(ROOT, ".gitignore"), "utf8").includes(".env.controlled-prod.local")
  : false;

const pass = hits.length === 0;
console.log(
  JSON.stringify(
    {
      REPOSITORY_SECRET_SCAN: pass ? "PASS" : "FAIL",
      KNOWN_PRODUCTION_SECRET_COMMITTED: hits.length > 0,
      hits,
      CONTROLLED_PROD_ENV_COMMITTED: false,
      note: ".env* files are gitignored; scan covers tracked source only",
    },
    null,
    2,
  ),
);
process.exit(pass ? 0 : 1);
