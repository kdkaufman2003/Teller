#!/usr/bin/env node
/**
 * Read-only pre-Phase 10 production baseline snapshot.
 * Usage: TELLER_CONTROLLED_PROD_TEST=1 node scripts/snapshot-pre-phase10-production.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";
const PROJECT_REF = "ypixbxicdecwfafculha";

const PHASE10_TABLES = [
  "teller_report_line_groups",
  "teller_account_report_mappings",
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
  const normalDebit = subtype === "receivable" || subtype === "bank" || subtype === "fixed_asset";
  return Math.round(
    (lines ?? []).reduce(
      (sum, line) =>
        sum +
        (normalDebit
          ? Number(line.debit ?? 0) - Number(line.credit ?? 0)
          : Number(line.credit ?? 0) - Number(line.debit ?? 0)),
      0,
    ) * 100,
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

async function phase10PreState(supabase) {
  const tables = {};
  for (const table of PHASE10_TABLES) tables[table] = await tableExists(supabase, table);
  const rpcProbe = await supabase.rpc("teller_gl_account_totals", {
    p_organization_id: HFAC_ORG_ID,
    p_period_start: "2026-01-01",
    p_period_end: "2026-01-31",
  });
  const rpcPresent =
    !rpcProbe.error ||
    !/does not exist|schema cache|could not find/i.test(rpcProbe.error.message ?? "");
  const tablesPresent = Object.values(tables).some(Boolean);
  return { tables, rpcPresent, phase10SchemaAbsent: !tablesPresent && !rpcPresent };
}

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const capturedAt = new Date().toISOString();
  const [hfacJournal, globalJournal, phase10State, orgCount] = await Promise.all([
    journalIntegrity(supabase, HFAC_ORG_ID),
    globalJournalIntegrity(supabase),
    phase10PreState(supabase),
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
    customer_deposits_gl_balance: await glBalanceForSubtype(supabase, HFAC_ORG_ID, "deposit", "2300"),
    fixed_asset_gl_balance: await glBalanceForSubtype(supabase, HFAC_ORG_ID, "fixed_asset", "1500"),
    fixed_assets: await countRows(supabase, "teller_fixed_assets", HFAC_ORG_ID),
  };

  const snapshot = {
    snapshotKind: "pre-phase10-production-baseline",
    capturedAt,
    projectRef: PROJECT_REF,
    hfacOrganizationId: HFAC_ORG_ID,
    hfac,
    production: {
      organizations: orgCount,
      journal_entries: globalJournal.totalEntries,
      balanced_journal_entries: globalJournal.balancedCount,
      unbalanced_journal_entries: globalJournal.unbalancedCount,
      journalsBalanced: globalJournal.unbalancedCount === 0,
    },
    phase10PreState: phase10State,
    gates: {
      PRE_PHASE10_SNAPSHOT_CREATED: true,
      PHASE10_SCHEMA_CURRENTLY_ABSENT: phase10State.phase10SchemaAbsent,
      PRODUCTION_JOURNALS_BALANCED: globalJournal.unbalancedCount === 0,
    },
  };

  const dir = resolve(process.cwd(), "artifacts/controlled-prod-snapshots");
  mkdirSync(dir, { recursive: true });
  const stamp = capturedAt.replace(/[:.]/g, "-");
  const jsonPath = resolve(dir, `pre-phase10-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));

  console.log(
    JSON.stringify(
      {
        PRE_PHASE10_SNAPSHOT_CREATED: true,
        SNAPSHOT_PATH: jsonPath,
        PHASE10_SCHEMA_CURRENTLY_ABSENT: phase10State.phase10SchemaAbsent,
        PRODUCTION_JOURNALS_BALANCED: globalJournal.unbalancedCount === 0,
        hfac,
      },
      null,
      2,
    ),
  );

  process.exit(globalJournal.unbalancedCount === 0 ? 0 : 2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
