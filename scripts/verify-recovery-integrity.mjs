#!/usr/bin/env node
/**
 * Post-restore / recovery integrity checklist (read-only).
 * Safe for production when gated with TELLER_CONTROLLED_PROD_TEST=1.
 */
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG = "812be00d-3084-4227-ac71-ccbd22e4172c";

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

async function countTable(supabase, table, filter) {
  let query = supabase.from(table).select("id", { count: "exact", head: true });
  if (filter) query = filter(query);
  const { count, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const issues = [];
  const metrics = {};

  const journals = await auditJournalBalances(supabase);
  metrics.journal_count = journals.checked;
  metrics.unbalanced_journals = journals.unbalanced;
  if (journals.unbalanced > 0) {
    issues.push({ code: "UNBALANCED_JOURNALS", detail: String(journals.unbalanced) });
  }

  metrics.document_count = await countTable(supabase, "teller_documents");
  metrics.payment_count = await countTable(supabase, "teller_payments");
  metrics.legal_entity_count = await countTable(supabase, "teller_legal_entities");

  metrics.hfac_documents = await countTable(supabase, "teller_documents", (q) =>
    q.eq("organization_id", HFAC_ORG),
  );
  metrics.hfac_journals = await countTable(supabase, "teller_journal_entries", (q) =>
    q.eq("organization_id", HFAC_ORG),
  );

  const probes = [
    "teller_phase17b_journal_insert_blocked",
    "teller_phase17c_reliability_probe",
    "teller_phase17d_performance_probe",
    "teller_phase17e_operations_probe",
  ];
  metrics.probes = {};
  for (const rpc of probes) {
    const { data, error } = await supabase.rpc(rpc);
    metrics.probes[rpc] = error?.message?.includes("Could not find") ? null : data === true;
    if (metrics.probes[rpc] === false) {
      issues.push({ code: "PROBE_FAIL", detail: rpc });
    }
    if (metrics.probes[rpc] === null) {
      issues.push({ code: "PROBE_MISSING", detail: rpc });
    }
  }

  const pass = issues.length === 0;
  console.log(
    JSON.stringify(
      {
        RECOVERY_INTEGRITY_CHECK: pass ? "PASS" : "FAIL",
        metrics,
        issues,
        readOnly: true,
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
