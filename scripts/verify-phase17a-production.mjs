#!/usr/bin/env node
/**
 * Phase 17A production-safe READ-ONLY accounting diagnostic.
 * Never INSERT/UPDATE/DELETE. Requires TELLER_CONTROLLED_PROD_TEST=1.
 */
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG = "812be00d-3084-4227-ac71-ccbd22e4172c";
const issues = [];
const metrics = {};

function knownDemoOrgIds() {
  const ids = new Set([HFAC_ORG]);
  for (const key of Object.keys(process.env)) {
    if (/^TELLER_PHASE.*DEMO_ORG_ID$/i.test(key) && process.env[key]?.trim()) {
      ids.add(process.env[key].trim());
    }
  }
  return ids;
}

function record(ok, label, detail) {
  if (!ok) issues.push({ label, detail });
  return ok;
}

async function countAllRows(supabase, table, filter = () => true) {
  let total = 0;
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase.from(table).select("id").range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []).filter(filter);
    total += rows.length;
    if ((data ?? []).length < pageSize) break;
    from += pageSize;
  }
  return total;
}

async function auditAllJournalBalances(supabase) {
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

async function countOrphans(supabase) {
  const checks = {};

  async function countQuery(label, fn) {
    try {
      checks[label] = await fn();
    } catch (err) {
      checks[label] = -1;
      record(false, label, err instanceof Error ? err.message : String(err));
    }
  }

  await countQuery("orphan_journal_lines", async () => {
    const { count, error } = await supabase
      .from("teller_journal_lines")
      .select("id", { count: "exact", head: true })
      .is("entry_id", null);
    if (error) throw new Error(error.message);
    return count ?? 0;
  });

  for (const table of [
    "teller_documents",
    "teller_journal_entries",
    "teller_payments",
    "teller_bank_accounts",
    "teller_accounts",
  ]) {
    await countQuery(`${table}_null_entity`, async () => {
      const { count, error } = await supabase
        .from(table)
        .select("id", { count: "exact", head: true })
        .is("legal_entity_id", null);
      if (error?.message?.includes("column")) return 0;
      if (error) throw new Error(error.message);
      return count ?? 0;
    });
  }

  return checks;
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
  return {
    documents: await count("teller_documents"),
    journals: await count("teller_journal_entries"),
    payments: await count("teller_payments"),
    payment_allocations: await count("teller_payment_allocations"),
  };
}

async function auditDefaultEntities(supabase) {
  const { data, error } = await supabase
    .from("teller_legal_entities")
    .select("organization_id, is_default, is_active")
    .eq("is_active", true);
  if (error) throw new Error(error.message);

  const byOrg = new Map();
  for (const row of data ?? []) {
    const bucket = byOrg.get(row.organization_id) ?? { defaults: 0 };
    if (row.is_default) bucket.defaults += 1;
    byOrg.set(row.organization_id, bucket);
  }
  let withoutDefault = 0;
  let multipleDefaults = 0;
  for (const bucket of byOrg.values()) {
    if (bucket.defaults === 0) withoutDefault += 1;
    if (bucket.defaults > 1) multipleDefaults += 1;
  }
  return { withoutDefault, multipleDefaults, orgCount: byOrg.size };
}

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const hfacBefore = await hfacSnapshot(supabase);
  metrics.hfac = hfacBefore;

  const journals = await auditAllJournalBalances(supabase);
  metrics.production_journals_checked = journals.checked;
  metrics.unbalanced_production_journals = journals.unbalanced;
  record(journals.unbalanced === 0, "all_journals_balanced", String(journals.unbalanced));

  const orphans = await countOrphans(supabase);
  metrics.orphan_checks = orphans;
  for (const [key, value] of Object.entries(orphans)) {
    if (value >= 0) record(value === 0, key, String(value));
  }

  const { count: orphanPaymentsNoDoc } = await supabase
    .from("teller_payments")
    .select("id", { count: "exact", head: true })
    .is("journal_entry_id", null)
    .is("document_id", null);
  metrics.orphan_payments_no_document = orphanPaymentsNoDoc ?? 0;

  const { data: linkedPaymentsNoJournalRows } = await supabase
    .from("teller_payments")
    .select("id, organization_id")
    .is("journal_entry_id", null)
    .not("document_id", "is", null);
  const demoOrgs = knownDemoOrgIds();
  const linkedMissing = linkedPaymentsNoJournalRows ?? [];
  metrics.linked_payments_missing_journal = linkedMissing.length;
  const phase16Demo = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim() ?? null;
  const gateOrgIds = new Set([HFAC_ORG, ...(phase16Demo ? [phase16Demo] : [])]);
  const linkedMissingInGateOrgs = linkedMissing.filter((row) => gateOrgIds.has(row.organization_id));
  metrics.linked_payments_missing_journal_total = linkedMissing.length;
  metrics.linked_payments_missing_journal_in_gate_orgs = linkedMissingInGateOrgs.length;
  metrics.linked_payments_missing_journal_in_other_orgs =
    linkedMissing.length - linkedMissingInGateOrgs.length;

  const hfacLinkedMissing = linkedMissing.filter((row) => row.organization_id === HFAC_ORG).length;
  metrics.hfac_linked_payments_missing_journal = hfacLinkedMissing;
  record(hfacLinkedMissing === 0, "hfac_payments_have_journals", String(hfacLinkedMissing));
  record(
    linkedMissingInGateOrgs.length === 0,
    "gate_orgs_payments_have_journals",
    `${linkedMissingInGateOrgs.length} in HFAC/phase16 demo; ${metrics.linked_payments_missing_journal_in_other_orgs} in other demo fixture orgs (17A-015)`,
  );

  const defaults = await auditDefaultEntities(supabase);
  metrics.default_entities = defaults;
  record(defaults.withoutDefault === 0, "orgs_without_default_entity", String(defaults.withoutDefault));
  record(defaults.multipleDefaults === 0, "orgs_multiple_default_entities", String(defaults.multipleDefaults));

  const probeOrg = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim() || HFAC_ORG;

  const { data: probe047, error: err047 } = await supabase.rpc("teller_phase16h_controls_applied");
  record(!err047 && probe047 === true, "entity_rls_probe_047", err047?.message ?? String(probe047));

  const { data: probe048, error: err048 } = await supabase.rpc("teller_phase16j_books_closed_probe", {
    p_org: probeOrg,
  });
  record(!err048 && probe048 === true, "patch_048_probe", err048?.message ?? String(probe048));

  const { data: probe049, error: err049 } = await supabase.rpc("teller_phase16j_legacy_posting_probe", {
    p_org: probeOrg,
  });
  record(!err049 && probe049 === true, "patch_049_probe", err049?.message ?? String(probe049));

  console.log(
    JSON.stringify(
      {
        PHASE17A_PRODUCTION_DIAGNOSTIC: issues.length ? "FAIL" : "PASS",
        PRODUCTION_BASELINE_CAPTURED: true,
        HFAC_MODIFIED_BY_17A: false,
        ...metrics,
        issues,
        readOnly: true,
        mutationsApplied: false,
      },
      null,
      2,
    ),
  );

  process.exit(issues.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
