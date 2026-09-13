/**
 * Phase 17D controlled performance acceptance (~40 checks).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import { parseListPagination, DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE } from "../src/lib/performance/pagination";
import { CONSOLIDATED_ENTITY_CONCURRENCY } from "../src/lib/accounting/consolidated/entity-parallel";

type Result = { name: string; pass: boolean; detail?: string };
const ROOT = process.cwd();
const HFAC_ORG = TELLER_HFAC_ORG_ID;

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function pass(name: string, ok: boolean, detail?: string): Result {
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

function runStaticSuite(): Result[] {
  const r: Result[] = [];
  const patch053 = read("supabase/patches/053_phase17d_performance_hardening.sql");
  const balances = read("src/lib/accounting/balances.ts");
  const invoices = read("src/app/api/invoices/route.ts");
  const bills = read("src/app/api/bills/route.ts");
  const ledger = read("src/app/api/ledger/route.ts");
  const banking = read("src/app/api/banking/transactions/route.ts");
  const jobProfit = read("src/lib/accounting/job-profitability.ts");
  const apDash = read("src/lib/accounting/ap-dashboard.ts");

  r.push(pass("patch_053_exists", existsSync(join(ROOT, "supabase/patches/053_phase17d_performance_hardening.sql"))));
  r.push(pass("patch_053_indexes", patch053.includes("create index if not exists")));
  r.push(pass("patch_053_probe", patch053.includes("teller_phase17d_performance_probe")));
  r.push(pass("patch_053_no_drops", !/drop index/i.test(patch053)));
  r.push(pass("patch_053_static_verifier", existsSync(join(ROOT, "scripts/verify-migration-053-static.mjs"))));

  r.push(pass("pagination_module", existsSync(join(ROOT, "src/lib/performance/pagination.ts"))));
  r.push(pass("bounded_parallel_module", existsSync(join(ROOT, "src/lib/performance/bounded-parallel.ts"))));
  r.push(pass("performance_doc", existsSync(join(ROOT, "docs/PHASE-17D-PERFORMANCE.md"))));
  r.push(pass("phase17d_tests", existsSync(join(ROOT, "src/lib/performance/phase17d.test.ts"))));
  r.push(pass("benchmark_script", existsSync(join(ROOT, "scripts/benchmark-phase17d.mjs"))));
  r.push(pass("production_verify_script", existsSync(join(ROOT, "scripts/verify-phase17d-production.mjs"))));

  r.push(pass("batch_remaining_helper", balances.includes("batchAuthoritativeDocumentRemaining")));
  r.push(pass("ap_dashboard_batch", apDash.includes("batchAuthoritativeDocumentRemaining")));
  r.push(pass("bills_api_pagination", bills.includes(".range(") && bills.includes("batchAuthoritativeDocumentRemaining")));
  r.push(pass("invoices_api_pagination", invoices.includes(".range(")));
  r.push(pass("ledger_date_bounds", ledger.includes("useDbPagination") && ledger.includes("addDaysISO(-365")));
  r.push(pass("bank_tx_pagination", banking.includes("Math.min") && banking.includes("limit")));

  r.push(pass("job_lines_scoped", jobProfit.includes('.eq("job_id", jobId)')));
  r.push(pass("job_no_full_org_entry_scan", !jobProfit.includes('from("teller_journal_entries").select("id")')));

  r.push(pass("consolidated_parallel_pl", read("src/lib/accounting/consolidated/profit-loss.ts").includes("mapConsolidatedEntities")));
  r.push(pass("consolidated_parallel_bs", read("src/lib/accounting/consolidated/balance-sheet.ts").includes("mapConsolidatedEntities")));
  r.push(pass("consolidated_parallel_cf", read("src/lib/accounting/consolidated/cash-flow.ts").includes("mapConsolidatedEntities")));
  r.push(pass("consolidated_parallel_tb", read("src/lib/accounting/consolidated/trial-balance.ts").includes("mapConsolidatedEntities")));
  r.push(pass("consolidated_concurrency_bounded", CONSOLIDATED_ENTITY_CONCURRENCY === 4));

  r.push(pass("no_rls_disable_in_patch", !/disable row level security/i.test(patch053)));
  r.push(pass("no_idempotency_removal", !balances.includes("randomUUID")));
  r.push(pass("canonical_posting_intact", read("src/lib/accounting/post.ts").includes("teller_post_journal")));

  const parsed = parseListPagination(new URLSearchParams("page=2&pageSize=50"));
  r.push(pass("pagination_defaults", parsed.page === 2 && parsed.pageSize === 50 && parsed.offset === 50));
  r.push(pass("pagination_max_cap", parseListPagination(new URLSearchParams("pageSize=9999")).pageSize === MAX_LIST_PAGE_SIZE));
  r.push(pass("pagination_default_size", parseListPagination(new URLSearchParams()).pageSize === DEFAULT_LIST_PAGE_SIZE));

  r.push(pass("gl_report_pagination_helper", read("src/lib/accounting/gl-report.ts").includes("paginateGlReport")));
  r.push(pass("report_engine_rpc_path", read("src/lib/accounting/report-engine.ts").includes("fetchGlAccountTotals")));

  r.push(pass("unsafe_accounting_cache_none", !read("src/lib/accounting/report-engine.ts").includes("unstable_cache")));
  r.push(pass("17c_reliability_preserved", existsSync(join(ROOT, "src/lib/reliability/idempotency.ts"))));

  return r;
}

async function runDbSuite(orgId: string, supabase: SupabaseClient): Promise<Result[]> {
  const r: Result[] = [];
  const { data: probe053, error: err053 } = await supabase.rpc("teller_phase17d_performance_probe");
  if (err053?.message?.includes("Could not find the function")) {
    r.push(pass("patch_053_applied", false, "Manual apply required"));
  } else {
    r.push(pass("patch_053_probe", probe053 === true, String(probe053)));
  }

  const { data: probe052 } = await supabase.rpc("teller_phase17c_reliability_probe");
  r.push(pass("patch_052_still_applied", probe052 === true, String(probe052)));

  const { count: hfacDocs } = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG);
  const { count: hfacJournals } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG);
  r.push(pass("hfac_documents", (hfacDocs ?? 0) === 8, String(hfacDocs)));
  r.push(pass("hfac_journals", (hfacJournals ?? 0) === 17, String(hfacJournals)));

  const { count: invoicePage } = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("kind", "invoice");
  const pagination = parseListPagination(new URLSearchParams("page=1&pageSize=10"));
  const { data: invoiceRows, error: invoiceErr } = await supabase
    .from("teller_documents")
    .select("id")
    .eq("organization_id", orgId)
    .eq("kind", "invoice")
    .range(pagination.offset, pagination.offset + pagination.limit - 1);
  r.push(pass("invoice_pagination_query", !invoiceErr && (invoiceRows?.length ?? 0) <= 10));
  r.push(pass("invoice_count_readable", invoicePage != null, String(invoicePage)));

  let unbalanced = 0;
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId)
    .limit(50);
  for (const entry of entries ?? []) {
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("entry_id", entry.id as string);
    const debit = (lines ?? []).reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const credit = (lines ?? []).reduce((s, l) => s + Number(l.credit ?? 0), 0);
    if (Math.abs(debit - credit) > 0.009) unbalanced += 1;
  }
  r.push(pass("demo_journals_balanced_sample", unbalanced === 0, String(unbalanced)));

  return r;
}

async function main() {
  const staticResults = runStaticSuite();
  let dbResults: Result[] = [];
  if (process.env.TELLER_CONTROLLED_PROD_TEST === "1") {
    const { orgId, supabase } = loadEnv();
    dbResults = await runDbSuite(orgId, supabase);
  } else {
    dbResults.push(pass("db_suite_skipped", true, "TELLER_CONTROLLED_PROD_TEST not set"));
  }

  const all = [...staticResults, ...dbResults];
  const failed = all.filter((x) => !x.pass);
  console.log(`Phase 17D performance acceptance: ${all.length - failed.length}/${all.length} PASS`);
  for (const row of all) {
    console.log(`${row.pass ? "PASS" : "FAIL"} ${row.name}${row.detail ? ` (${row.detail})` : ""}`);
  }
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
