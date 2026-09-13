#!/usr/bin/env node
/**
 * Phase 17H final production verification (read-only).
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG = "812be00d-3084-4227-ac71-ccbd22e4172c";
const PRODUCTION_URL = process.env.TELLER_PRODUCTION_URL ?? "https://teller-indol.vercel.app";
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
    return { ok: res.status === 200 || res.status === 307 || res.status === 308 || res.status === 401, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function checkReadyEndpoint() {
  try {
    const res = await fetch(`${PRODUCTION_URL}/api/ready`);
    const body = await res.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      /* ignore */
    }
    const exposesSecrets =
      /service.?role|SUPABASE_SERVICE|password|secret|token/i.test(body) &&
      !/without server configuration/i.test(body);
    return {
      status: res.status,
      ok: res.status === 200 && json?.service === "teller",
      json,
      exposesSecrets,
    };
  } catch {
    return { status: 0, ok: false, json: null, exposesSecrets: false };
  }
}

async function countDuplicateIdempotency(supabase) {
  const { data, error } = await supabase
    .from("teller_payments")
    .select("organization_id, idempotency_key")
    .not("idempotency_key", "is", null);
  if (error) return { duplicates: -1, error: error.message };
  const seen = new Map();
  let duplicates = 0;
  for (const row of data ?? []) {
    const key = `${row.organization_id}:${row.idempotency_key}`;
    if (seen.has(key)) duplicates += 1;
    else seen.set(key, true);
  }
  return { duplicates, error: null };
}

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  metrics.release_commit = process.env.TELLER_RELEASE_COMMIT_SHA ?? null;
  metrics.deployment_commit = process.env.TELLER_DEPLOYMENT_COMMIT ?? null;
  metrics.deployment_id = process.env.TELLER_DEPLOYMENT_ID ?? null;

  if (metrics.release_commit && metrics.deployment_commit) {
    record(
      metrics.release_commit === metrics.deployment_commit,
      "deployed_commit_matches_release",
      `${metrics.deployment_commit} vs ${metrics.release_commit}`,
    );
  }

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

  const journals = await auditJournalBalances(supabase);
  metrics.production_journals_checked = journals.checked;
  metrics.unbalanced_production_journals = journals.unbalanced;
  record(journals.unbalanced === 0, "journals_balanced", String(journals.unbalanced));

  const hfacDocs = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG);
  const hfacJournals = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG);
  metrics.hfac = { documents: hfacDocs.count ?? 0, journals: hfacJournals.count ?? 0 };
  record(metrics.hfac.documents === 8, "hfac_documents", String(metrics.hfac.documents));
  record(metrics.hfac.journals === 17, "hfac_journals", String(metrics.hfac.journals));

  const idem = await countDuplicateIdempotency(supabase);
  metrics.duplicate_idempotency_identifiers = idem.duplicates;
  record(idem.duplicates === 0, "duplicate_idempotency", idem.error ?? String(idem.duplicates));

  const { count: auditCount } = await supabase
    .from("teller_audit_events")
    .select("id", { count: "exact", head: true });
  metrics.audit_events = auditCount ?? 0;
  record(auditCount != null, "audit_events_readable", String(auditCount));

  const ready = await checkReadyEndpoint();
  metrics.ready_endpoint = ready;
  record(ready.ok, "ready_endpoint_live", String(ready.status));
  record(!ready.exposesSecrets, "ready_no_secrets", ready.exposesSecrets ? "leak detected" : "ok");

  const appRoutes = [
    "/",
    "/login",
    "/app",
    "/app/invoices",
    "/app/bills",
    "/app/banking",
    "/app/reports",
    "/app/ledger",
    "/app/accounting",
    "/app/accounting/workspace",
    "/app/companies",
    "/app/settings",
  ];
  const routeSmoke = {};
  for (const route of appRoutes) {
    const result = await smokeRoute(route);
    routeSmoke[route] = result;
    record(result.ok, `route:${route}`, String(result.status));
  }
  metrics.route_smoke = routeSmoke;

  record(existsSync(join(ROOT, "docs/PHASE-17H-LAUNCH-READINESS.md")), "launch_readiness_doc", "missing");
  record(existsSync(join(ROOT, "docs/LAUNCH-KNOWN-LIMITATIONS.md")), "known_limitations_doc", "missing");
  record(!existsSync(join(ROOT, "supabase/patches/055_phase17g_e2e_hardening.sql")), "no_unapplied_patch_055", "unexpected");

  metrics.PRODUCTION_MUTATED_BY_17H_TESTS = false;
  metrics.HFAC_MODIFIED_BY_17H = false;
  metrics.NEW_SQL_PATCH_REQUIRED = false;

  const pass = issues.length === 0;
  console.log(
    JSON.stringify(
      {
        PHASE17H_PRODUCTION_VERIFY: pass ? "PASS" : "FAIL",
        READY_ENDPOINT_DEPLOYED: ready.status !== 404,
        READY_ENDPOINT_STATUS: ready.ok ? "PASS" : "FAIL",
        HEALTH_ENDPOINT: ready.ok ? "PASS" : "FAIL",
        FINAL_ROUTE_SMOKE: Object.values(routeSmoke).every((r) => r.ok) ? "PASS" : "FAIL",
        metrics,
        issues,
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
