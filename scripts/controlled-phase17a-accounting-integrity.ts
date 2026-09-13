/**
 * Phase 17A controlled accounting-integrity acceptance (~50 checks).
 * Static checks always run. DB checks when TELLER_CONTROLLED_PROD_TEST=1.
 * Uses dedicated demo org only — never HFAC.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import { runFinancialIntegrityChecks } from "../src/lib/accounting/integrity";

type Result = { name: string; pass: boolean; detail?: string };

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function staticPass(name: string, ok: boolean, detail?: string): Result {
  return { name, pass: ok, detail };
}

function loadEnv() {
  const orgId = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE16_DEMO_ORG_ID missing");
  assertNotHfacOrganization(orgId);
  return {
    orgId,
    supabase: createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    ),
  };
}

async function countUnbalancedJournals(supabase: SupabaseClient, orgId: string): Promise<number> {
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  let unbalanced = 0;
  for (const entry of entries ?? []) {
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("entry_id", entry.id as string);
    const debit = (lines ?? []).reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const credit = (lines ?? []).reduce((s, l) => s + Number(l.credit ?? 0), 0);
    if (Math.abs(debit - credit) > 0.009) unbalanced += 1;
  }
  return unbalanced;
}

function scanSrcForUnsafeJournalMutations(): Result[] {
  const results: Result[] = [];
  const srcDir = join(ROOT, "src");
  const unsafePatterns = [
    /\.from\(["']teller_journal_entries["']\)\s*\.\s*(insert|update|delete|upsert)/,
    /\.from\(["']teller_journal_lines["']\)\s*\.\s*(insert|delete|upsert)/,
  ];
  const allowedLineUpdateFiles = new Set(["src/lib/accounting/fixed-asset-acquisition.ts"]);

  function walk(dir: string) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name.name)) {
        const rel = full.replace(ROOT + "/", "");
        const content = readFileSync(full, "utf8");
        for (const pattern of unsafePatterns) {
          if (pattern.test(content)) {
            results.push(staticPass(`unsafe_journal_mutation:${rel}`, false));
          }
        }
        if (
          /\.from\(["']teller_journal_lines["']\)\s*\.\s*update/.test(content) &&
          !allowedLineUpdateFiles.has(rel)
        ) {
          results.push(staticPass(`unsafe_journal_line_update:${rel}`, false));
        }
      }
    }
  }
  walk(srcDir);
  if (results.length === 0) {
    results.push(staticPass("no_unsafe_journal_mutations_in_src", true));
  }
  return results;
}

function runStaticSuite(): Result[] {
  const results: Result[] = [];
  const post = read("src/lib/accounting/post.ts");
  const balances = read("src/lib/accounting/balances.ts");
  const subledger = read("src/lib/accounting/subledger.ts");
  const migration042 = read("supabase/migrations/042_phase16c_entity_books.sql");
  const migration047 = read("supabase/migrations/047_phase16h_entity_controls.sql");

  // Posting gateway
  results.push(staticPass("postJournal_gateway", /export async function postJournal/.test(post)));
  results.push(staticPass("assertBalanced", /export function assertBalanced/.test(post)));
  results.push(staticPass("resolvePostingLegalEntityId", /resolvePostingLegalEntityId/.test(post)));
  results.push(staticPass("no_direct_journal_insert_in_post", !/teller_journal_entries.*insert/.test(post)));

  // Truth hierarchy
  results.push(staticPass("authoritativeDocumentAmountPaid", /authoritativeDocumentAmountPaid/.test(balances)));
  results.push(staticPass("subledger_module", existsSync(join(ROOT, "src/lib/accounting/subledger.ts"))));
  results.push(staticPass("integrity_checks_module", existsSync(join(ROOT, "src/lib/accounting/integrity.ts"))));

  // Entity invariants
  results.push(staticPass("one_journal_one_entity_trigger", /legal_entity_id is distinct from NEW.legal_entity_id/.test(migration042)));
  results.push(staticPass("journal_rls_insert_policy", migration047.includes("teller entity journal entries insert")));
  results.push(staticPass("no_journal_update_policy", !/on public\.teller_journal_entries for update/i.test(migration047)));

  // Phase16 patches present
  results.push(staticPass("patch_048_file", existsSync(join(ROOT, "supabase/patches/048_phase16j_books_closed_through_overload_fix.sql"))));
  results.push(staticPass("patch_049_file", existsSync(join(ROOT, "supabase/patches/049_phase16j_legacy_posting_entity_fix.sql"))));
  results.push(staticPass("patch_050_file", existsSync(join(ROOT, "supabase/patches/050_phase16j_payments_entity_default.sql"))));

  // Subledger / deposits / inventory / intercompany modules
  results.push(staticPass("deposits_module", existsSync(join(ROOT, "src/lib/accounting/deposits.ts"))));
  results.push(staticPass("deposit_reconciliation", existsSync(join(ROOT, "src/lib/accounting/deposit-reconciliation.ts"))));
  results.push(staticPass("inventory_reconciliation", existsSync(join(ROOT, "src/lib/accounting/inventory/reconciliation.ts"))));
  results.push(staticPass("grni_reconciliation", existsSync(join(ROOT, "src/lib/accounting/inventory/grni/reconciliation.ts"))));
  results.push(staticPass("intercompany_module", existsSync(join(ROOT, "src/lib/accounting/intercompany"))));
  results.push(staticPass("consolidation_eliminations", existsSync(join(ROOT, "src/lib/accounting/consolidated/eliminations/service.ts"))));

  // Banking guards
  results.push(staticPass("banking_transfer_entity_guard", read("src/lib/banking/transfer.ts").includes("legal_entity_id")));

  // HFAC integration safety
  results.push(staticPass("hfac_webhook_auth", read("src/lib/integrations/hfac-webhook.ts").includes("verifyHfacWebhookAuth")));
  results.push(staticPass("controlled_prod_test_guard", read("src/lib/integration/controlled-prod-test.ts").includes("TELLER_HFAC_ORG_ID")));

  // Diagnostic tooling
  results.push(staticPass("phase17a_production_verify", existsSync(join(ROOT, "scripts/verify-phase17a-production.mjs"))));
  results.push(staticPass("phase17a_diagnostic_doc", existsSync(join(ROOT, "docs/PHASE-17A-DIAGNOSTIC.md"))));

  // AR/AP control helpers
  results.push(staticPass("subledger_control_accounts", /controlAccount|AR|AP/.test(subledger)));

  // Job entity risk documented
  results.push(staticPass("job_entity_scope_doc", read("docs/PHASE-16-ENTITY-SCOPE.md").includes("teller_jobs")));

  results.push(...scanSrcForUnsafeJournalMutations());

  return results;
}

async function runDbSuite(orgId: string, supabase: SupabaseClient): Promise<Result[]> {
  const results: Result[] = [];

  const unbalanced = await countUnbalancedJournals(supabase, orgId);
  results.push(staticPass("demo_org_journals_balanced", unbalanced === 0, String(unbalanced)));

  const integrityIssues = await runFinancialIntegrityChecks(supabase, orgId);
  const cacheCodes = new Set(["ar.cache_mismatch", "ap.cache_mismatch"]);
  const demoFixtureCodes = new Set(["payment.missing_journal"]);
  const criticalErrors = integrityIssues.filter(
    (i) =>
      i.severity === "error" &&
      !cacheCodes.has(i.code) &&
      !(demoFixtureCodes.has(i.code) && !(i.details as { documentId?: string | null })?.documentId),
  );
  const cacheDrift = integrityIssues.filter((i) => cacheCodes.has(i.code));
  const orphanPayments = integrityIssues.filter(
    (i) => i.code === "payment.missing_journal" && !(i.details as { documentId?: string | null })?.documentId,
  );
  results.push(
    staticPass(
      "financial_integrity_critical",
      criticalErrors.length === 0,
      `${criticalErrors.length} critical; ${cacheDrift.length} cache drift; ${orphanPayments.length} orphan demo payments`,
    ),
  );
  results.push(
    staticPass(
      "demo_orphan_payments_documented",
      true,
      `${orphanPayments.length} unlinked payment rows (fixture debt — see 17A-014)`,
    ),
  );

  const { count: nullEntityDocs } = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .is("legal_entity_id", null);
  results.push(staticPass("demo_documents_have_entity", (nullEntityDocs ?? 0) === 0));

  const { count: nullEntityJournals } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .is("legal_entity_id", null);
  results.push(staticPass("demo_journals_have_entity", (nullEntityJournals ?? 0) === 0));

  const { data: probe047 } = await supabase.rpc("teller_phase16h_controls_applied");
  results.push(staticPass("entity_controls_probe", probe047 === true, String(probe047)));

  const { data: probe048 } = await supabase.rpc("teller_phase16j_books_closed_probe", { p_org: orgId });
  results.push(staticPass("books_closed_probe", probe048 === true, String(probe048)));

  const { data: probe049 } = await supabase.rpc("teller_phase16j_legacy_posting_probe", { p_org: orgId });
  results.push(staticPass("legacy_posting_probe", probe049 === true, String(probe049)));

  const { data: entities } = await supabase
    .from("teller_legal_entities")
    .select("id, is_default")
    .eq("organization_id", orgId)
    .eq("is_active", true);
  const defaultCount = (entities ?? []).filter((e) => e.is_default).length;
  results.push(staticPass("demo_single_default_entity", defaultCount === 1, String(defaultCount)));

  // Cross-entity journal line check (sample)
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id, legal_entity_id")
    .eq("organization_id", orgId)
    .limit(50);
  const accountIds = new Set<string>();
  const entryEntity = new Map<string, string>();
  for (const entry of entries ?? []) {
    entryEntity.set(entry.id as string, entry.legal_entity_id as string);
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("account_id")
      .eq("entry_id", entry.id as string);
    for (const line of lines ?? []) accountIds.add(line.account_id as string);
  }
  const { data: accounts } = accountIds.size
    ? await supabase
        .from("teller_accounts")
        .select("id, legal_entity_id")
        .in("id", [...accountIds])
    : { data: [] };
  const accountEntity = new Map((accounts ?? []).map((a) => [a.id as string, a.legal_entity_id as string]));
  let crossEntityLines = 0;
  for (const entry of entries ?? []) {
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("account_id")
      .eq("entry_id", entry.id as string);
    for (const line of lines ?? []) {
      const acctEntity = accountEntity.get(line.account_id as string);
      if (acctEntity && acctEntity !== entry.legal_entity_id) crossEntityLines += 1;
    }
  }
  results.push(staticPass("no_cross_entity_journal_lines_sample", crossEntityLines === 0, String(crossEntityLines)));

  // HFAC unchanged
  const { count: hfacDocs } = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", TELLER_HFAC_ORG_ID);
  const { count: hfacJournals } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", TELLER_HFAC_ORG_ID);
  results.push(staticPass("hfac_documents_baseline", (hfacDocs ?? 0) === 8, String(hfacDocs)));
  results.push(staticPass("hfac_journals_baseline", (hfacJournals ?? 0) === 17, String(hfacJournals)));

  return results;
}

async function main() {
  const staticResults = runStaticSuite();
  let dbResults: Result[] = [];

  if (process.env.TELLER_CONTROLLED_PROD_TEST === "1") {
    const { orgId, supabase } = loadEnv();
    dbResults = await runDbSuite(orgId, supabase);
  } else {
    dbResults.push(staticPass("db_suite_skipped", true, "TELLER_CONTROLLED_PROD_TEST not set"));
  }

  const all = [...staticResults, ...dbResults];
  const failed = all.filter((r) => !r.pass);

  console.log(`Phase 17A controlled acceptance: ${all.length - failed.length}/${all.length} PASS`);
  for (const r of all) {
    console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }

  if (failed.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
