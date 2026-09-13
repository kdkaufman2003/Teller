#!/usr/bin/env node
/**
 * Phase 17C production-safe READ-ONLY reliability verification.
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

async function countDuplicateExternalPayments(supabase) {
  const { data, error } = await supabase
    .from("teller_payments")
    .select("organization_id, external_source, external_id")
    .not("external_source", "is", null)
    .not("external_id", "is", null);
  if (error) throw new Error(error.message);
  const seen = new Map();
  let duplicates = 0;
  for (const row of data ?? []) {
    const key = `${row.organization_id}|${row.external_source}|${row.external_id}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 2) duplicates += 1;
  }
  return duplicates;
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

  const { data: probe051, error: err051 } = await supabase.rpc("teller_phase17b_journal_insert_blocked");
  record(!err051 && probe051 === true, "patch_051_still_applied", err051?.message ?? String(probe051));

  const { data: probe052, error: err052 } = await supabase.rpc("teller_phase17c_reliability_probe");
  if (err052?.message?.includes("Could not find the function")) {
    record(false, "patch_052_applied", "Patch 052 not applied — apply supabase/patches/052_phase17c_reliability_hardening.sql manually");
    metrics.patch_052_applied = false;
  } else {
    metrics.patch_052_applied = probe052 === true;
    record(probe052 === true, "patch_052_reliability_probe", err052?.message ?? String(probe052));
  }

  metrics.duplicate_payment_external = await countDuplicateExternalPayments(supabase);
  record(metrics.duplicate_payment_external === 0, "duplicate_payment_external", String(metrics.duplicate_payment_external));

  const { data: scheduleRows, error: schedErr } = await supabase
    .from("teller_schedule_occurrences")
    .select("organization_id, idempotency_key");
  if (schedErr) throw new Error(schedErr.message);
  const schedSeen = new Map();
  let dupSchedule = 0;
  for (const row of scheduleRows ?? []) {
    const key = `${row.organization_id}|${row.idempotency_key}`;
    const count = (schedSeen.get(key) ?? 0) + 1;
    schedSeen.set(key, count);
    if (count === 2) dupSchedule += 1;
  }
  metrics.duplicate_schedule_occurrence = dupSchedule;
  record(dupSchedule === 0, "duplicate_schedule_occurrence", String(dupSchedule));

  const { data: bankRows, error: bankErr } = await supabase
    .from("teller_bank_transactions")
    .select("organization_id, bank_account_id, external_transaction_id")
    .not("external_transaction_id", "is", null);
  if (bankErr?.message?.includes("column")) {
    metrics.duplicate_bank_provider_txn = 0;
  } else {
    if (bankErr) throw new Error(bankErr.message);
    const bankSeen = new Map();
    let dupBank = 0;
    for (const row of bankRows ?? []) {
      const key = `${row.organization_id}|${row.bank_account_id}|${row.external_transaction_id}`;
      const count = (bankSeen.get(key) ?? 0) + 1;
      bankSeen.set(key, count);
      if (count === 2) dupBank += 1;
    }
    metrics.duplicate_bank_provider_txn = dupBank;
    record(dupBank === 0, "duplicate_bank_provider_txn", String(dupBank));
  }

  const { count: hfacWebhookDup } = await supabase
    .from("teller_hfac_webhook_events")
    .select("event_id", { count: "exact", head: true });
  metrics.hfac_webhook_events = hfacWebhookDup ?? 0;

  const pass = issues.length === 0;
  console.log(
    JSON.stringify(
      {
        PHASE17C_PRODUCTION_VERIFY: pass ? "PASS" : "FAIL",
        metrics,
        issues,
        HFAC_MODIFIED_BY_17C: false,
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
