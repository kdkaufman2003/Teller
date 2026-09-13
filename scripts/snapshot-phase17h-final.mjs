#!/usr/bin/env node
/**
 * Phase 17H production baseline snapshot (read-only, non-secret).
 * Usage: TELLER_CONTROLLED_PROD_TEST=1 node scripts/snapshot-phase17h-final.mjs [pre|post]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG = "812be00d-3084-4227-ac71-ccbd22e4172c";
const PHASE16_DEMO_ORG = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim();

async function countRows(supabase, table, filter) {
  let query = supabase.from(table).select("id", { count: "exact", head: true });
  if (filter) query = filter(query);
  const { count, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
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

async function main() {
  const phase = process.argv[2] === "post" ? "post" : "pre";
  loadControlledProdEnv();

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const journals = await auditJournalBalances(supabase);

  const snapshot = {
    phase17h: phase,
    capturedAt: new Date().toISOString(),
    projectRef: "ypixbxicdecwfafculha",
    productionUrl: "https://teller-indol.vercel.app",
    global: {
      organizations: await countRows(supabase, "teller_organizations"),
      legal_entities: await countRows(supabase, "teller_legal_entities"),
      documents: await countRows(supabase, "teller_documents"),
      payments: await countRows(supabase, "teller_payments"),
      journal_entries: journals.checked,
      journal_lines: await countRows(supabase, "teller_journal_lines"),
      audit_events: await countRows(supabase, "teller_audit_events"),
      unbalanced_journals: journals.unbalanced,
    },
    hfac: {
      organization_id: HFAC_ORG,
      documents: await countRows(supabase, "teller_documents", (q) => q.eq("organization_id", HFAC_ORG)),
      journals: await countRows(supabase, "teller_journal_entries", (q) =>
        q.eq("organization_id", HFAC_ORG),
      ),
      failed_events: await (async () => {
        const { count, error } = await supabase
          .from("teller_hfac_webhook_events")
          .select("event_id", { count: "exact", head: true })
          .eq("processing_status", "failed");
        return error ? null : (count ?? 0);
      })(),
    },
    demo_fixture: PHASE16_DEMO_ORG
      ? {
          organization_id: PHASE16_DEMO_ORG,
          orphan_payments_probe: await countRows(supabase, "teller_payments", (q) =>
            q.eq("organization_id", PHASE16_DEMO_ORG).is("document_id", null),
          ),
        }
      : null,
    patch_probes: {},
  };

  for (const rpc of [
    "teller_phase17b_journal_insert_blocked",
    "teller_phase17c_reliability_probe",
    "teller_phase17d_performance_probe",
    "teller_phase17e_operations_probe",
  ]) {
    const { data } = await supabase.rpc(rpc);
    snapshot.patch_probes[rpc] = data === true;
  }

  const dir = resolve(process.cwd(), "artifacts/controlled-prod-snapshots");
  mkdirSync(dir, { recursive: true });
  const stamp = snapshot.capturedAt.replace(/[:.]/g, "-");
  const jsonPath = resolve(dir, `${phase}-phase17h-final-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));

  console.log(JSON.stringify({ ok: true, jsonPath, snapshot }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
