#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC = "812be00d-3084-4227-ac71-ccbd22e4172c";

async function main() {
  loadControlledProdEnv();
  const phase7Org = process.env.TELLER_PHASE7_DEMO_ORG_ID?.trim();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  async function count(table, org = null) {
    let q = supabase.from(table).select("id", { count: "exact", head: true });
    if (org) q = q.eq("organization_id", org);
    const { count: n } = await q;
    return n ?? 0;
  }

  async function glBalance(org, code) {
    const { data: accts } = await supabase
      .from("teller_accounts")
      .select("id")
      .eq("organization_id", org)
      .eq("code", code);
    const id = accts?.[0]?.id;
    if (!id) return null;
    const { data: entries } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .eq("organization_id", org);
    const ids = (entries ?? []).map((e) => e.id);
    if (!ids.length) return 0;
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("account_id", id)
      .in("entry_id", ids);
    return Math.round(
      (lines ?? []).reduce((sum, l) => sum + Number(l.debit ?? 0) - Number(l.credit ?? 0), 0) * 100,
    ) / 100;
  }

  const hfac = {
    documents: await count("teller_documents", HFAC),
    payments: await count("teller_payments", HFAC),
    payment_allocations: await count("teller_payment_allocations", HFAC),
    journal_entries: await count("teller_journal_entries", HFAC),
    jobs: await count("teller_jobs", HFAC),
    ar: await glBalance(HFAC, "1100"),
    ap: await glBalance(HFAC, "2000"),
  };

  const { data: allEntries } = await supabase.from("teller_journal_entries").select("id");
  const allIds = (allEntries ?? []).map((e) => e.id);
  const { data: allLines } = await supabase
    .from("teller_journal_lines")
    .select("entry_id, debit, credit")
    .in("entry_id", allIds);
  const byEntry = new Map();
  for (const line of allLines ?? []) {
    const row = byEntry.get(line.entry_id) ?? { debit: 0, credit: 0 };
    row.debit += Number(line.debit ?? 0);
    row.credit += Number(line.credit ?? 0);
    byEntry.set(line.entry_id, row);
  }
  let unbalanced = 0;
  for (const totals of byEntry.values()) {
    if (Math.abs(totals.debit - totals.credit) > 0.009) unbalanced++;
  }

  const { data: accounts } = await supabase
    .from("teller_accounts")
    .select("id, type")
    .eq("organization_id", phase7Org);
  const { data: orgEntries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", phase7Org);
  const orgEntryIds = (orgEntries ?? []).map((e) => e.id);
  const { data: orgLines } = await supabase
    .from("teller_journal_lines")
    .select("account_id, debit, credit, job_id, cost_classification")
    .in("entry_id", orgEntryIds);
  const typeById = new Map((accounts ?? []).map((a) => [a.id, a.type]));

  let glRevenue = 0;
  let jobRevenue = 0;
  let glDirectCost = 0;
  let jobDirectCost = 0;
  for (const line of orgLines ?? []) {
    const type = typeById.get(line.account_id);
    const debit = Number(line.debit ?? 0);
    const credit = Number(line.credit ?? 0);
    if (type === "revenue" && Math.abs(credit - debit) > 0.009) {
      const amount = credit - debit;
      glRevenue += amount;
      if (line.job_id) jobRevenue += amount;
    }
    if (
      (type === "expense" || type === "cogs") &&
      (line.cost_classification ?? "direct") !== "indirect" &&
      debit > credit + 0.009
    ) {
      const amount = debit - credit;
      glDirectCost += amount;
      if (line.job_id) jobDirectCost += amount;
    }
  }

  const snap = JSON.parse(
    readFileSync("artifacts/controlled-prod-snapshots/pre-phase7-2026-09-06T23-04-13-709Z.json", "utf8"),
  );

  console.log(
    JSON.stringify(
      {
        PHASE7_DEMO_ORG_ID: phase7Org,
        hfac,
        snapshotHfac: snap.hfac ?? snap.expectedHfac,
        HFAC_BASELINE_UNCHANGED:
          hfac.documents === 8 &&
          hfac.payments === 3 &&
          hfac.payment_allocations === 3 &&
          hfac.journal_entries === 16 &&
          hfac.jobs === 0 &&
          hfac.ar === 1500 &&
          hfac.ap === 0,
        PRODUCTION_JOURNALS_BALANCED: unbalanced === 0,
        globalJournalCount: allIds.length,
        snapshotJournalCount: snap.globalCounts?.journal_entries,
        phase7RecordsOnHfac: {
          jobs: await count("teller_jobs", HFAC),
          budgetLines: await count("teller_job_budget_lines", HFAC),
          documentSequences: await count("teller_document_sequences", HFAC),
        },
        GL_REVENUE_ACTIVITY: Math.round(glRevenue * 100) / 100,
        GL_JOB_REVENUE: Math.round(jobRevenue * 100) / 100,
        GL_UNASSIGNED_REVENUE: Math.round((glRevenue - jobRevenue) * 100) / 100,
        GL_REVENUE_DIFFERENCE: Math.round((glRevenue - jobRevenue) * 100) / 100,
        GL_DIRECT_COST_ACTIVITY: Math.round(glDirectCost * 100) / 100,
        GL_JOB_DIRECT_COST: Math.round(jobDirectCost * 100) / 100,
        GL_UNASSIGNED_DIRECT_COST: Math.round((glDirectCost - jobDirectCost) * 100) / 100,
        GL_DIRECT_COST_DIFFERENCE: Math.round((glDirectCost - jobDirectCost) * 100) / 100,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
