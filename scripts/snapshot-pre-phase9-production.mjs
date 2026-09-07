#!/usr/bin/env node
/**
 * Read-only pre-Phase 9 production baseline snapshot.
 * Usage: TELLER_CONTROLLED_PROD_TEST=1 node scripts/snapshot-pre-phase9-production.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const PROJECT_REF = "ypixbxicdecwfafculha";

const EXPECTED_HFAC = {
  documents: 8,
  payments: 3,
  payment_allocations: 3,
  document_allocations: 0,
  journal_entries: 16,
  jobs: 0,
  vendors: 2,
  ar_gl_balance: 1500.0,
  ap_gl_balance: 0.0,
  fixed_assets: 0,
};

const PHASE9_TABLES = [
  "teller_accounting_state_versions",
  "teller_close_settings",
  "teller_period_close_reviews",
  "teller_close_checklist_items",
  "teller_adjusting_journal_entries",
  "teller_recurring_journal_templates",
  "teller_recurring_journal_runs",
];

async function countRows(supabase, table, orgId = null) {
  let query = supabase.from(table).select("*", { count: "exact", head: true });
  if (orgId) query = query.eq("organization_id", orgId);
  const { count, error } = await query;
  if (error) {
    const msg = (error.message ?? "").toLowerCase();
    if (msg.includes("does not exist") || msg.includes("schema cache")) return null;
    throw new Error(`${table}: ${error.message}`);
  }
  return count ?? 0;
}

async function tableExists(supabase, table) {
  const { error } = await supabase.from(table).select("*").limit(1);
  if (!error) return true;
  const msg = (error.message ?? "").toLowerCase();
  return !(msg.includes("does not exist") || msg.includes("schema cache"));
}

async function journalIntegrity(supabase, orgId) {
  const { data: entries, error } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  const entryIds = (entries ?? []).map((row) => row.id);
  if (!entryIds.length) {
    return { entryCount: 0, lineCount: 0, balancedCount: 0, unbalancedCount: 0 };
  }
  const { data: lines, error: linesError } = await supabase
    .from("teller_journal_lines")
    .select("entry_id, debit, credit")
    .in("entry_id", entryIds);
  if (linesError) throw new Error(linesError.message);
  const byEntry = new Map();
  for (const line of lines ?? []) {
    const current = byEntry.get(line.entry_id) ?? { debit: 0, credit: 0 };
    current.debit += Number(line.debit ?? 0);
    current.credit += Number(line.credit ?? 0);
    byEntry.set(line.entry_id, current);
  }
  let balancedCount = 0;
  let unbalancedCount = 0;
  for (const totals of byEntry.values()) {
    if (Math.abs(totals.debit - totals.credit) > 0.009) unbalancedCount += 1;
    else balancedCount += 1;
  }
  return {
    entryCount: entryIds.length,
    lineCount: (lines ?? []).length,
    balancedCount,
    unbalancedCount,
  };
}

async function globalJournalIntegrity(supabase) {
  const { data: entries, error } = await supabase.from("teller_journal_entries").select("id");
  if (error) throw new Error(error.message);
  const entryIds = (entries ?? []).map((row) => row.id);
  if (!entryIds.length) return { totalEntries: 0, balancedCount: 0, unbalancedCount: 0 };
  const { data: lines, error: linesError } = await supabase
    .from("teller_journal_lines")
    .select("entry_id, debit, credit")
    .in("entry_id", entryIds);
  if (linesError) throw new Error(linesError.message);
  const byEntry = new Map();
  for (const line of lines ?? []) {
    const current = byEntry.get(line.entry_id) ?? { debit: 0, credit: 0 };
    current.debit += Number(line.debit ?? 0);
    current.credit += Number(line.credit ?? 0);
    byEntry.set(line.entry_id, current);
  }
  let balancedCount = 0;
  let unbalancedCount = 0;
  for (const totals of byEntry.values()) {
    if (Math.abs(totals.debit - totals.credit) > 0.009) unbalancedCount += 1;
    else balancedCount += 1;
  }
  return { totalEntries: entryIds.length, balancedCount, unbalancedCount };
}

async function glBalanceForSubtype(supabase, orgId, subtype, fallbackCode) {
  const { data: accounts } = await supabase
    .from("teller_accounts")
    .select("id, code, subtype")
    .eq("organization_id", orgId);
  const account = (accounts ?? []).find((a) => a.subtype === subtype || a.code === fallbackCode);
  if (!account) return null;
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  const entryIds = (entries ?? []).map((row) => row.id);
  if (!entryIds.length) return 0;
  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("debit, credit")
    .eq("account_id", account.id)
    .in("entry_id", entryIds);
  return Math.round(
    (lines ?? []).reduce((sum, line) => sum + Number(line.debit ?? 0) - Number(line.credit ?? 0), 0) * 100,
  ) / 100;
}

async function vendorCount(supabase, orgId) {
  const { count } = await supabase
    .from("teller_parties")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .in("kind", ["vendor", "both"]);
  return count ?? 0;
}

async function closedThroughByOrg(supabase) {
  const { data: orgs } = await supabase.from("teller_organizations").select("id, name");
  const result = [];
  for (const org of orgs ?? []) {
    const { data: closes } = await supabase
      .from("teller_period_closes")
      .select("period_end, effective_closed_through, closed_at, event_type")
      .eq("organization_id", org.id)
      .order("closed_at", { ascending: false })
      .limit(1);
    if (closes?.length) {
      result.push({
        organizationId: org.id,
        name: org.name,
        latest: closes[0],
      });
    }
  }
  return result;
}

async function demoOrgSnapshot(supabase, envKey) {
  const orgId = process.env[envKey]?.trim();
  if (!orgId) return { configured: false, envKey };
  return {
    configured: true,
    envKey,
    organizationId: orgId,
    documents: await countRows(supabase, "teller_documents", orgId),
    journal_entries: (await journalIntegrity(supabase, orgId)).entryCount,
    jobs: await countRows(supabase, "teller_jobs", orgId),
    fixed_assets: await countRows(supabase, "teller_fixed_assets", orgId),
    period_closes: await countRows(supabase, "teller_period_closes", orgId),
  };
}

function amountsMatch(a, b) {
  return Math.abs(Number(a) - Number(b)) <= 0.009;
}

async function phase9PreState(supabase) {
  const tables = {};
  for (const table of PHASE9_TABLES) tables[table] = await tableExists(supabase, table);
  const anyPresent = Object.values(tables).some(Boolean);
  return { tables, phase9SchemaAbsent: !anyPresent };
}

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const capturedAt = new Date().toISOString();
  const [hfacJournal, globalJournal, phase9State, closedThrough, orgCount] = await Promise.all([
    journalIntegrity(supabase, HFAC_ORG_ID),
    globalJournalIntegrity(supabase),
    phase9PreState(supabase),
    closedThroughByOrg(supabase),
    countRows(supabase, "teller_organizations"),
  ]);

  const hfac = {
    documents: await countRows(supabase, "teller_documents", HFAC_ORG_ID),
    payments: await countRows(supabase, "teller_payments", HFAC_ORG_ID),
    payment_allocations: await countRows(supabase, "teller_payment_allocations", HFAC_ORG_ID),
    document_allocations: await countRows(supabase, "teller_document_allocations", HFAC_ORG_ID),
    journal_entries: hfacJournal.entryCount,
    jobs: await countRows(supabase, "teller_jobs", HFAC_ORG_ID),
    vendors: await vendorCount(supabase, HFAC_ORG_ID),
    ar_gl_balance: await glBalanceForSubtype(supabase, HFAC_ORG_ID, "receivable", "1100"),
    ap_gl_balance: await glBalanceForSubtype(supabase, HFAC_ORG_ID, "payable", "2000"),
    fixed_assets: await countRows(supabase, "teller_fixed_assets", HFAC_ORG_ID),
    bank_reconciliations: await countRows(supabase, "teller_bank_reconciliations", HFAC_ORG_ID),
    period_closes: await countRows(supabase, "teller_period_closes", HFAC_ORG_ID),
    adjustment_journals: await countRows(supabase, "teller_journal_entries", HFAC_ORG_ID).then(async () => {
      const { count } = await supabase
        .from("teller_journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", HFAC_ORG_ID)
        .eq("source_kind", "adjustment");
      return count ?? 0;
    }),
  };

  const hfacMatches =
    hfac.documents === EXPECTED_HFAC.documents &&
    hfac.payments === EXPECTED_HFAC.payments &&
    hfac.payment_allocations === EXPECTED_HFAC.payment_allocations &&
    hfac.document_allocations === EXPECTED_HFAC.document_allocations &&
    hfac.journal_entries === EXPECTED_HFAC.journal_entries &&
    hfac.jobs === EXPECTED_HFAC.jobs &&
    hfac.vendors === EXPECTED_HFAC.vendors &&
    amountsMatch(hfac.ar_gl_balance, EXPECTED_HFAC.ar_gl_balance) &&
    amountsMatch(hfac.ap_gl_balance, EXPECTED_HFAC.ap_gl_balance) &&
    (hfac.fixed_assets ?? 0) === EXPECTED_HFAC.fixed_assets;

  const snapshot = {
    snapshotKind: "pre-phase9-production-baseline",
    capturedAt,
    projectRef: PROJECT_REF,
    hfacOrganizationId: HFAC_ORG_ID,
    expectedHfacBaseline: EXPECTED_HFAC,
    hfacBaselineMatchesExpected: hfacMatches,
    hfac,
    production: {
      organizations: orgCount,
      journal_entries: globalJournal.totalEntries,
      balanced_journal_entries: globalJournal.balancedCount,
      unbalanced_journal_entries: globalJournal.unbalancedCount,
      journalsBalanced: globalJournal.unbalancedCount === 0,
      closedThroughByOrg: closedThrough,
    },
    demoOrgs: {
      phase5: await demoOrgSnapshot(supabase, "TELLER_PHASE5_DEMO_ORG_ID"),
      phase6: await demoOrgSnapshot(supabase, "TELLER_PHASE6_DEMO_ORG_ID"),
      phase7: await demoOrgSnapshot(supabase, "TELLER_PHASE7_DEMO_ORG_ID"),
      phase8: await demoOrgSnapshot(supabase, "TELLER_PHASE8_DEMO_ORG_ID"),
    },
    phase9PreState: phase9State,
    gates: {
      PRE_PHASE9_SNAPSHOT_CREATED: true,
      HFAC_BASELINE_MATCHES_EXPECTED: hfacMatches,
      PHASE9_SCHEMA_CURRENTLY_ABSENT: phase9State.phase9SchemaAbsent,
      PRODUCTION_JOURNALS_BALANCED: globalJournal.unbalancedCount === 0,
    },
  };

  const dir = resolve(process.cwd(), "artifacts/controlled-prod-snapshots");
  mkdirSync(dir, { recursive: true });
  const stamp = capturedAt.replace(/[:.]/g, "-");
  const jsonPath = resolve(dir, `pre-phase9-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));

  console.log(
    JSON.stringify(
      {
        PRE_PHASE9_SNAPSHOT_CREATED: true,
        SNAPSHOT_PATH: jsonPath,
        HFAC_BASELINE_MATCHES_EXPECTED: hfacMatches,
        PHASE9_SCHEMA_CURRENTLY_ABSENT: phase9State.phase9SchemaAbsent,
        PRODUCTION_JOURNALS_BALANCED: globalJournal.unbalancedCount === 0,
      },
      null,
      2,
    ),
  );

  process.exit(hfacMatches && phase9State.phase9SchemaAbsent ? 0 : 2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
