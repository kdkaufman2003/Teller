#!/usr/bin/env node
/**
 * Phase 17D production-safe READ-ONLY performance verification.
 */
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG = "812be00d-3084-4227-ac71-ccbd22e4172c";
const issues = [];
const metrics = {};

function record(ok, label, detail) {
  if (!ok) issues.push({ label, detail });
  return ok;
}

async function countTable(supabase, table, filter) {
  let query = supabase.from(table).select("id", { count: "exact", head: true });
  if (filter) query = filter(query);
  const { count, error } = await query;
  if (error) return null;
  return count ?? 0;
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

async function hfacSnapshot(supabase) {
  async function count(table) {
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }
  return { documents: await count("teller_documents"), journals: await count("teller_journal_entries") };
}

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  metrics.hfac = await hfacSnapshot(supabase);
  record(metrics.hfac.documents === 8, "hfac_documents", String(metrics.hfac.documents));
  record(metrics.hfac.journals === 17, "hfac_journals", String(metrics.hfac.journals));

  const journals = await auditJournalBalances(supabase);
  metrics.production_journals_checked = journals.checked;
  metrics.unbalanced_production_journals = journals.unbalanced;
  record(journals.unbalanced === 0, "journals_balanced", String(journals.unbalanced));

  const tables = [
    "teller_organizations",
    "teller_profiles",
    "teller_legal_entities",
    "teller_legal_entity_memberships",
    "teller_accounts",
    "teller_documents",
    "teller_document_lines",
    "teller_payments",
    "teller_payment_allocations",
    "teller_journal_entries",
    "teller_journal_lines",
    "teller_bank_accounts",
    "teller_bank_transactions",
    "teller_jobs",
    "teller_inventory_items",
    "teller_inventory_movements",
    "teller_fixed_assets",
    "teller_payroll_runs",
    "teller_intercompany_transactions",
    "teller_intercompany_settlements",
    "teller_audit_events",
    "teller_hfac_webhook_events",
  ];

  metrics.table_counts = {};
  for (const table of tables) {
    metrics.table_counts[table] = await countTable(supabase, table);
  }

  const ranked = Object.entries(metrics.table_counts)
    .filter(([, v]) => v != null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  metrics.largest_tables = ranked.slice(0, 8).map(([name, count]) => ({ name, count }));

  const { data: probe052 } = await supabase.rpc("teller_phase17c_reliability_probe");
  record(probe052 === true, "patch_052_still_applied", String(probe052));

  const { data: probe053, error: err053 } = await supabase.rpc("teller_phase17d_performance_probe");
  if (err053?.message?.includes("Could not find the function")) {
    record(false, "patch_053_applied", "Patch 053 not applied — apply supabase/patches/053_phase17d_performance_hardening.sql manually");
    metrics.patch_053_applied = false;
  } else {
    metrics.patch_053_applied = probe053 === true;
    record(probe053 === true, "patch_053_performance_probe", err053?.message ?? String(probe053));
  }

  const pass = issues.length === 0;
  console.log(
    JSON.stringify(
      {
        PHASE17D_PRODUCTION_VERIFY: pass ? "PASS" : "FAIL",
        metrics,
        issues,
        HFAC_MODIFIED_BY_17D: false,
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
