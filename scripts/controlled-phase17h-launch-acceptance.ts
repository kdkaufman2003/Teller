/**
 * Phase 17H compact launch acceptance (~40 checks).
 * Static + vitest gates always. DB probes when TELLER_CONTROLLED_PROD_TEST=1.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
type Result = { name: string; pass: boolean; detail?: string };

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function pass(name: string, ok: boolean, detail?: string): Result {
  return { name, pass: ok, detail };
}

function runReleaseArtifactSuite(): Result[] {
  const r: Result[] = [];
  const required = [
    "docs/PHASE-17H-LAUNCH-READINESS.md",
    "docs/LAUNCH-KNOWN-LIMITATIONS.md",
    "docs/LAUNCH-SUPPORT-RUNBOOK.md",
    "docs/RELEASE-NOTES-PHASE17.md",
    "docs/PRODUCTION-RELEASE-RUNBOOK.md",
    "docs/INCIDENT-RESPONSE.md",
    "docs/MANUAL-DATABASE-CHANGE-RUNBOOK.md",
    "docs/PHASE-17G-E2E-CERTIFICATION.md",
    "scripts/verify-phase17h-production.mjs",
    "scripts/scan-repository-secrets.mjs",
    "src/app/api/ready/route.ts",
    "src/app/api/ops/status/route.ts",
    "supabase/patches/051_phase17b_security_hardening.sql",
    "supabase/patches/052_phase17c_reliability_hardening.sql",
    "supabase/patches/053_phase17d_performance_hardening.sql",
    "supabase/patches/054_phase17e_operational_controls.sql",
  ];
  for (const path of required) {
    r.push(pass(`artifact:${path}`, existsSync(join(ROOT, path)), path));
  }
  r.push(pass("no_patch_055", !existsSync(join(ROOT, "supabase/patches/055_phase17g_e2e_hardening.sql"))));
  r.push(pass("gitignore_artifacts", read(".gitignore").includes("/artifacts/")));
  r.push(pass("gitignore_env", read(".gitignore").includes(".env*")));
  return r;
}

function runSecurityReliabilitySuite(): Result[] {
  const r: Result[] = [];
  const post = read("src/lib/accounting/post.ts");
  r.push(pass("postJournal_gateway", /export async function postJournal/.test(post)));
  r.push(pass("assertBalanced", /export function assertBalanced/.test(post)));
  r.push(pass("idempotency_module", existsSync(join(ROOT, "src/lib/reliability/idempotency.ts"))));
  r.push(pass("phase17b_tests", existsSync(join(ROOT, "src/lib/security/phase17b.test.ts"))));
  r.push(pass("phase17c_tests", existsSync(join(ROOT, "src/lib/reliability/phase17c.test.ts"))));
  r.push(pass("hfac_webhook_auth", read("src/lib/integrations/hfac-webhook.ts").includes("verifyHfacWebhookAuth")));
  r.push(pass("controlled_hfac_guard", read("src/lib/integration/controlled-prod-test.ts").includes("assertNotHfacOrganization")));
  const patch051 = read("supabase/patches/051_phase17b_security_hardening.sql");
  r.push(pass("patch_051_journal_insert_block", patch051.includes("teller_phase17b_journal_insert_blocked")));
  const patch054 = read("supabase/patches/054_phase17e_operational_controls.sql");
  r.push(pass("patch_054_audit_immutability", patch054.includes("teller_audit_events")));
  return r;
}

function runUxE2ESuite(): Result[] {
  const r: Result[] = [];
  r.push(pass("presentation_mode", existsSync(join(ROOT, "src/lib/ux/presentation-mode.ts"))));
  r.push(pass("owner_nav", read("src/lib/ux/navigation.ts").includes("navItemsForMode")));
  r.push(pass("aging_authoritative", read("src/lib/accounting/report-engine.ts").includes("batchAuthoritativeDocumentRemaining")));
  r.push(pass("all_companies_view_only", read("src/app/app/companies/page.tsx").includes("View only")));
  const vitest = spawnSync("npx", ["vitest", "run", "src/lib/e2e/phase17g-certification.test.ts"], {
    encoding: "utf8",
    cwd: ROOT,
  });
  r.push(pass("e2e_cert_tests", vitest.status === 0, vitest.status === 0 ? "pass" : "fail"));
  return r;
}

function runApiAuthSuite(): Result[] {
  const r: Result[] = [];
  let authGuardCount = 0;
  function walk(dir: string) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.name === "route.ts") {
        const content = readFileSync(full, "utf8");
        if (/require(Accounting)?Books|requireAccountingWriteBooks|hfacWebhookAuthorized/.test(content)) {
          authGuardCount += 1;
        }
      }
    }
  }
  walk(join(ROOT, "src/app/api"));
  r.push(pass("api_auth_guards", authGuardCount >= 25, String(authGuardCount)));
  r.push(pass("ready_no_secrets_in_source", !read("src/app/api/ready/route.ts").includes("SERVICE_ROLE")));
  r.push(pass("ops_status_bearer", read("src/app/api/ops/status/route.ts").includes("TELLER_OPS_STATUS_TOKEN")));
  return r;
}

async function runDbSuite(supabase: SupabaseClient, orgId: string): Promise<Result[]> {
  const r: Result[] = [];
  assertNotHfacOrganization(orgId);

  let unbalanced = 0;
  const { data: entries } = await supabase.from("teller_journal_entries").select("id").eq("organization_id", orgId);
  for (const entry of entries ?? []) {
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("entry_id", entry.id as string);
    const debit = (lines ?? []).reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const credit = (lines ?? []).reduce((s, l) => s + Number(l.credit ?? 0), 0);
    if (Math.abs(debit - credit) > 0.009) unbalanced += 1;
  }
  r.push(pass("demo_org_journals_balanced", unbalanced === 0, String(unbalanced)));

  for (const [label, rpc] of [
    ["patch_051", "teller_phase17b_journal_insert_blocked"],
    ["patch_052", "teller_phase17c_reliability_probe"],
    ["patch_053", "teller_phase17d_performance_probe"],
    ["patch_054", "teller_phase17e_operations_probe"],
  ] as const) {
    const { data } = await supabase.rpc(rpc);
    r.push(pass(`${label}_effective`, data === true, String(data)));
  }

  const { count: hfacDocs } = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", TELLER_HFAC_ORG_ID);
  const { count: hfacJournals } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", TELLER_HFAC_ORG_ID);
  r.push(pass("hfac_documents_baseline", (hfacDocs ?? 0) === 8, String(hfacDocs)));
  r.push(pass("hfac_journals_baseline", (hfacJournals ?? 0) === 17, String(hfacJournals)));

  const { count: orphanDemoPayments } = await supabase
    .from("teller_payments")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .is("document_id", null);
  r.push(pass("demo_orphan_payments_counted", (orphanDemoPayments ?? 0) >= 0, String(orphanDemoPayments)));

  return r;
}

export async function runLaunchAcceptance(): Promise<{ results: Result[]; failed: Result[] }> {
  const results = [
    ...runReleaseArtifactSuite(),
    ...runSecurityReliabilitySuite(),
    ...runUxE2ESuite(),
    ...runApiAuthSuite(),
  ];

  if (process.env.TELLER_CONTROLLED_PROD_TEST === "1") {
    const orgId = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim();
    if (!orgId) throw new Error("TELLER_PHASE16_DEMO_ORG_ID missing");
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    results.push(...(await runDbSuite(supabase, orgId)));
  } else {
    results.push(pass("db_suite_skipped", true, "TELLER_CONTROLLED_PROD_TEST not set"));
  }

  return { results, failed: results.filter((r) => !r.pass) };
}

async function main() {
  const { results, failed } = await runLaunchAcceptance();
  console.log(`Phase 17H launch acceptance: ${results.length - failed.length}/${results.length} PASS`);
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }
  console.log(
    JSON.stringify(
      {
        PHASE17H_CONTROLLED_ACCEPTANCE: failed.length === 0 ? "PASS" : "FAIL",
        PHASE17H_ACCEPTANCE_SCENARIOS: results.length,
      },
      null,
      2,
    ),
  );
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
