#!/usr/bin/env node
/**
 * Create a Supabase preview branch for Phase 5 from production (ypixbxicdecwfafculha).
 * Requires: supabase login OR SUPABASE_ACCESS_TOKEN in environment.
 *
 * Usage: node scripts/setup-phase5-preview.mjs
 */
import { execSync } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PRODUCTION_REF = "ypixbxicdecwfafculha";
const BRANCH_NAME = "phase5-banking";

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function main() {
  if (!process.env.SUPABASE_ACCESS_TOKEN?.trim()) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: "Missing SUPABASE_ACCESS_TOKEN. Run: npx supabase login",
          hint: "Then re-run: node scripts/setup-phase5-preview.mjs",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const createJson = run(
    `npx supabase@latest branches create ${BRANCH_NAME} --project-ref ${PRODUCTION_REF} --experimental -o json`,
  );
  const branch = JSON.parse(createJson);

  const detailsJson = run(
    `npx supabase@latest branches get ${branch.id} --project-ref ${PRODUCTION_REF} --experimental -o json`,
  );
  const details = JSON.parse(detailsJson);

  const previewRef = details.project_ref ?? details.ref ?? branch.project_ref;
  const dbUrl = details.db_url ?? details.database?.connection_string ?? null;

  const envPath = resolve(process.cwd(), ".env.integration");
  const examplePath = resolve(process.cwd(), ".env.integration.example");
  const template = existsSync(envPath)
    ? readFileSync(envPath, "utf8")
    : readFileSync(examplePath, "utf8");

  const lines = template.split("\n").map((line) => {
    if (line.startsWith("NEXT_PUBLIC_SUPABASE_URL=")) {
      return `NEXT_PUBLIC_SUPABASE_URL=https://${previewRef}.supabase.co`;
    }
    if (line.startsWith("TELLER_EXPECTED_BRANCH=")) {
      return "TELLER_EXPECTED_BRANCH=phase5-banking";
    }
    if (line.startsWith("# NEVER use production ref")) {
      return `# Preview branch ref: ${previewRef} (parent: ${PRODUCTION_REF})`;
    }
    return line;
  });

  if (!lines.some((l) => l.startsWith("TELLER_EXPECTED_BRANCH="))) {
    lines.push("TELLER_EXPECTED_BRANCH=phase5-banking");
  }

  writeFileSync(envPath, `${lines.join("\n").trim()}\n`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        branchName: BRANCH_NAME,
        branchId: branch.id,
        previewRef,
        parentRef: PRODUCTION_REF,
        dbUrlConfigured: Boolean(dbUrl),
        nextSteps: [
          "Fill NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY from Supabase dashboard → preview branch settings",
          dbUrl ? "SUPABASE_DB_URL detected from branch API" : "Add SUPABASE_DB_URL from branch database settings",
          "npm run migrate:integration  (applies 001–018 if fresh branch)",
          "node scripts/apply-migration-018-preview.mjs  (018 only if branch already has 001–017)",
          "npm run verify:phase5-schema",
          "npm run test:integration",
        ],
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
  console.error(JSON.stringify({ ok: false, error: message, stderr }, null, 2));
  process.exit(1);
}
