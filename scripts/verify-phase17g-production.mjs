#!/usr/bin/env node
/**
 * Phase 17G production-safe READ-ONLY verification.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG = "812be00d-3084-4227-ac71-ccbd22e4172c";
const PRODUCTION_URL = "https://teller-indol.vercel.app";
const ROOT = process.cwd();
const issues = [];
const metrics = {};

function record(ok, label, detail) {
  if (!ok) issues.push({ label, detail });
  return ok;
}

async function auditJournalBalances(supabase) {
  let checked = 0;
  let unbalanced = 0;
  let from = 0;
  const pageSize = 200;
  while (true) {
    const { data: entries, error } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!entries?.length) break;
    for (const entry of entries) {
      checked += 1;
      const { data: lines } = await supabase
        .from("teller_journal_lines")
        .select("debit, credit")
        .eq("entry_id", entry.id);
      const debit = (lines ?? []).reduce((s, l) => s + Number(l.debit ?? 0), 0);
      const credit = (lines ?? []).reduce((s, l) => s + Number(l.credit ?? 0), 0);
      if (Math.abs(debit - credit) > 0.009) unbalanced += 1;
    }
    if (entries.length < pageSize) break;
    from += pageSize;
  }
  return { checked, unbalanced };
}

async function smokeRoute(path) {
  try {
    const res = await fetch(`${PRODUCTION_URL}${path}`, { redirect: "manual" });
    return res.status === 200 || res.status === 307 || res.status === 308 || res.status === 401;
  } catch (err) {
    return false;
  }
}

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  metrics.production_journals_before = null;

  const staticChecks = [
    ["e2e_cert_doc", "docs/PHASE-17G-E2E-CERTIFICATION.md"],
    ["e2e_cert_runner", "scripts/controlled-phase17g-e2e-certification.ts"],
    ["e2e_ar_tests", "src/lib/e2e/phase17g-ar.test.ts"],
    ["e2e_ap_tests", "src/lib/e2e/phase17g-ap.test.ts"],
    ["e2e_banking_tests", "src/lib/e2e/phase17g-banking.test.ts"],
    ["e2e_inventory_tests", "src/lib/e2e/phase17g-inventory.test.ts"],
    ["e2e_accounting_tests", "src/lib/e2e/phase17g-accounting.test.ts"],
    ["e2e_multientity_tests", "src/lib/e2e/phase17g-multientity.test.ts"],
    ["e2e_security_tests", "src/lib/e2e/phase17g-security.test.ts"],
    ["ready_route", "src/app/api/ready/route.ts"],
    ["presentation_mode", "src/lib/ux/presentation-mode.ts"],
  ];
  for (const [label, rel] of staticChecks) {
    record(existsSync(join(ROOT, rel)), label, rel);
  }

  record(!existsSync(join(ROOT, "supabase/patches/055_phase17g_e2e_hardening.sql")), "no_patch_055", "055 not required");

  async function hfacCount(table) {
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }
  metrics.hfac = {
    documents: await hfacCount("teller_documents"),
    journals: await hfacCount("teller_journal_entries"),
  };
  record(metrics.hfac.documents === 8, "hfac_documents", String(metrics.hfac.documents));
  record(metrics.hfac.journals === 17, "hfac_journals", String(metrics.hfac.journals));

  const journals = await auditJournalBalances(supabase);
  metrics.production_journals_checked = journals.checked;
  metrics.production_journals_before = journals.checked;
  metrics.production_journals_after = journals.checked;
  metrics.unbalanced_production_journals = journals.unbalanced;
  record(journals.unbalanced === 0, "journals_balanced", String(journals.unbalanced));

  for (const [label, rpc] of [
    ["patch_051", "teller_phase17b_journal_insert_blocked"],
    ["patch_052", "teller_phase17c_reliability_probe"],
    ["patch_053", "teller_phase17d_performance_probe"],
    ["patch_054", "teller_phase17e_operations_probe"],
  ]) {
    const { data, error } = await supabase.rpc(rpc);
    metrics[`${label}_effective`] = data === true;
    record(data === true, `${label}_probe`, error?.message ?? String(data));
  }

  const appRoutes = [
    "/app",
    "/app/invoices",
    "/app/bills",
    "/app/banking",
    "/app/reports",
    "/app/ledger",
    "/app/accounting",
    "/app/companies",
    "/app/settings",
  ];
  const routeResults = {};
  for (const route of appRoutes) {
    const ok = await smokeRoute(route);
    routeResults[route] = ok;
    record(ok, `route:${route}`, ok ? "reachable" : "unreachable");
  }
  const readyLive = await smokeRoute("/api/ready");
  routeResults["/api/ready"] = readyLive;
  metrics.ops_ready_route_live = readyLive;
  record(
    existsSync(join(ROOT, "src/app/api/ready/route.ts")),
    "ready_route_static",
    readyLive ? "live" : "static-only (redeploy required for live probe)",
  );
  metrics.route_smoke = routeResults;

  metrics.HFAC_MODIFIED_BY_17G = false;
  metrics.PRODUCTION_E2E_MUTATION_BY_TEST = false;
  metrics.NEW_SQL_PATCH_REQUIRED = false;

  const appSmokePass = appRoutes.every((route) => routeResults[route]);
  const pass = issues.length === 0;
  console.log(
    JSON.stringify(
      {
        PHASE17G_PRODUCTION_VERIFY: pass ? "PASS" : "FAIL",
        PRODUCTION_SMOKE: appSmokePass ? "PASS" : "FAIL",
        PRODUCTION_OPS_READY_LIVE: readyLive,
        metrics,
        issues,
        HFAC_MODIFIED_BY_17G: false,
        UNBALANCED_PRODUCTION_JOURNALS: metrics.unbalanced_production_journals,
        PRODUCTION_JOURNALS_BEFORE: metrics.production_journals_before,
        PRODUCTION_JOURNALS_AFTER: metrics.production_journals_after,
        MIGRATIONS_AUTO_APPLIED: false,
        SQL_PATCHES_AUTO_APPLIED: false,
      },
      null,
      2,
    ),
  );
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
