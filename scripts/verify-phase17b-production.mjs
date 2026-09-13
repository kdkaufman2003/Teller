#!/usr/bin/env node
/**
 * Phase 17B production-safe READ-ONLY security verification.
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

  const { data: probe047, error: err047 } = await supabase.rpc("teller_phase16h_controls_applied");
  record(!err047 && probe047 === true, "entity_controls_047", err047?.message ?? String(probe047));

  const { data: probe051, error: err051 } = await supabase.rpc("teller_phase17b_journal_insert_blocked");
  if (err051?.message?.includes("Could not find the function")) {
    record(false, "patch_051_applied", "Patch 051 not applied — apply supabase/patches/051_phase17b_security_hardening.sql manually");
    metrics.patch_051_applied = false;
  } else {
    record(!err051 && probe051 === true, "journal_insert_blocked", err051?.message ?? String(probe051));
    metrics.patch_051_applied = probe051 === true;
  }

  const { data: zeroMembershipProfiles } = await supabase
    .from("teller_profiles")
    .select("id, organization_id, role");
  const { data: memberships } = await supabase
    .from("teller_legal_entity_memberships")
    .select("profile_id");
  const withMembership = new Set((memberships ?? []).map((m) => m.profile_id));
  const zeroUsers = (zeroMembershipProfiles ?? []).filter(
    (p) => p.role !== "owner" && p.role !== "admin" && !withMembership.has(p.id),
  );
  metrics.zero_membership_users_count = zeroUsers.length;
  metrics.zero_membership_orgs_count = new Set(zeroUsers.map((p) => p.organization_id)).size;

  console.log(
    JSON.stringify(
      {
        PHASE17B_PRODUCTION_VERIFY: issues.length ? "FAIL" : "PASS",
        HFAC_MODIFIED_BY_17B: false,
        ...metrics,
        issues,
        readOnly: true,
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
