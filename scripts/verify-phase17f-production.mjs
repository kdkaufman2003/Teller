#!/usr/bin/env node
/**
 * Phase 17F production-safe READ-ONLY UX verification.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG = "812be00d-3084-4227-ac71-ccbd22e4172c";
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

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const staticChecks = [
    ["ux_audit_doc", "docs/PHASE-17F-UX-AUDIT.md"],
    ["presentation_mode_api", "src/app/api/ux/presentation-mode/route.ts"],
    ["ready_route", "src/app/api/ready/route.ts"],
    ["empty_state", "src/components/ui/EmptyState.tsx"],
    ["user_errors", "src/lib/ux/user-errors.ts"],
    ["navigation_model", "src/lib/ux/navigation.ts"],
    ["phase17f_tests", "src/lib/ux/phase17f.test.ts"],
  ];
  for (const [label, rel] of staticChecks) {
    record(existsSync(join(ROOT, rel)), label, rel);
  }

  const reportEngine = readFileSync(join(ROOT, "src/lib/accounting/report-engine.ts"), "utf8");
  record(
    reportEngine.includes("batchAuthoritativeDocumentRemaining"),
    "aging_authoritative_remaining",
    "report-engine",
  );

  async function hfacCount(table) {
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }
  metrics.hfac = { documents: await hfacCount("teller_documents"), journals: await hfacCount("teller_journal_entries") };
  record(metrics.hfac.documents === 8, "hfac_documents", String(metrics.hfac.documents));
  record(metrics.hfac.journals === 17, "hfac_journals", String(metrics.hfac.journals));

  const journals = await auditJournalBalances(supabase);
  metrics.production_journals_checked = journals.checked;
  metrics.unbalanced_production_journals = journals.unbalanced;
  record(journals.unbalanced === 0, "journals_balanced", String(journals.unbalanced));

  for (const [label, rpc] of [
    ["patch_051", "teller_phase17b_journal_insert_blocked"],
    ["patch_052", "teller_phase17c_reliability_probe"],
    ["patch_053", "teller_phase17d_performance_probe"],
    ["patch_054", "teller_phase17e_operations_probe"],
  ]) {
    const { data, error } = await supabase.rpc(rpc);
    metrics[`${label}_applied`] = data === true;
    record(data === true, `${label}_probe`, error?.message ?? String(data));
  }

  metrics.NEW_SQL_PATCH_REQUIRED = false;

  const pass = issues.length === 0;
  console.log(
    JSON.stringify(
      {
        PHASE17F_PRODUCTION_VERIFY: pass ? "PASS" : "FAIL",
        metrics,
        issues,
        HFAC_MODIFIED_BY_17F: false,
        UNBALANCED_PRODUCTION_JOURNALS: metrics.unbalanced_production_journals,
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
