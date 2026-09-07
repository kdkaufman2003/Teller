#!/usr/bin/env node
/**
 * Step A — read-only pre-Phase 8 production baseline snapshot.
 * Usage: TELLER_CONTROLLED_PROD_TEST=1 node scripts/snapshot-pre-phase8-production.mjs
 *
 * Does NOT apply migration 024, deploy code, or mutate production data.
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
};

const PHASE8_TABLES = [
  "teller_fixed_asset_settings",
  "teller_fixed_asset_categories",
  "teller_fixed_assets",
  "teller_fixed_asset_depreciation_schedule_lines",
  "teller_fixed_asset_depreciation_batches",
  "teller_fixed_asset_depreciation_entries",
  "teller_fixed_asset_journal_links",
  "teller_fixed_asset_disposal_idempotency",
];

const PHASE8_COLUMNS = [["teller_journal_lines", "fixed_asset_id"]];

async function countRows(supabase, table, orgId = null) {
  let query = supabase.from(table).select("*", { count: "exact", head: true });
  if (orgId) query = query.eq("organization_id", orgId);
  const { count, error } = await query;
  if (error) {
    const msg = (error.message ?? "").toLowerCase();
    if (msg.includes("does not exist") || msg.includes("schema cache")) return null;
    throw new Error(`${table}: ${error.message || JSON.stringify(error)}`);
  }
  return count ?? 0;
}

async function tableExists(supabase, table) {
  const { error } = await supabase.from(table).select("*").limit(1);
  if (!error) return true;
  const msg = (error.message ?? "").toLowerCase();
  return !(msg.includes("does not exist") || msg.includes("schema cache"));
}

async function columnExists(supabase, table, column) {
  if (!(await tableExists(supabase, table))) return false;
  const { error } = await supabase.from(table).select(column).limit(0);
  if (!error) return true;
  return !(error.message ?? "").toLowerCase().includes("column");
}

async function documentsByKind(supabase, orgId) {
  const { data, error } = await supabase
    .from("teller_documents")
    .select("kind")
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  const counts = {};
  for (const row of data ?? []) {
    const kind = row.kind || "unknown";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

async function jobsByStatus(supabase, orgId) {
  const { data, error } = await supabase
    .from("teller_jobs")
    .select("status, external_source, external_id")
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  const byStatus = {};
  const withExternal = [];
  for (const row of data ?? []) {
    const status = row.status || "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (row.external_source || row.external_id) {
      withExternal.push({
        status,
        external_source: row.external_source,
        external_id: row.external_id,
      });
    }
  }
  return { byStatus, withExternal, total: (data ?? []).length };
}

async function vendorCount(supabase, orgId) {
  const { count, error } = await supabase
    .from("teller_parties")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .in("kind", ["vendor", "both"]);
  if (error) throw new Error(`teller_parties vendors: ${error.message}`);
  return count ?? 0;
}

async function journalIntegrity(supabase, orgId) {
  const { data: entries, error } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  const entryIds = (entries ?? []).map((row) => row.id);
  if (!entryIds.length) {
    return { entryCount: 0, lineCount: 0, balancedCount: 0, unbalancedCount: 0, unbalanced: [] };
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

  const unbalanced = [];
  let balancedCount = 0;
  for (const [entryId, totals] of byEntry) {
    if (Math.abs(totals.debit - totals.credit) > 0.009) {
      unbalanced.push({ entryId, debit: totals.debit, credit: totals.credit });
    } else {
      balancedCount += 1;
    }
  }

  return {
    entryCount: entryIds.length,
    lineCount: (lines ?? []).length,
    balancedCount,
    unbalancedCount: unbalanced.length,
    unbalanced,
  };
}

async function globalJournalIntegrity(supabase) {
  const { data: entries, error } = await supabase.from("teller_journal_entries").select("id, organization_id");
  if (error) throw new Error(error.message);
  const entryIds = (entries ?? []).map((row) => row.id);
  if (!entryIds.length) {
    return { totalEntries: 0, totalLines: 0, balancedCount: 0, unbalancedCount: 0 };
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
    totalEntries: entryIds.length,
    totalLines: (lines ?? []).length,
    balancedCount,
    unbalancedCount,
  };
}

async function glBalanceForSubtype(supabase, orgId, subtype, fallbackCode) {
  const { data: accounts, error: accountsError } = await supabase
    .from("teller_accounts")
    .select("id, code, subtype")
    .eq("organization_id", orgId);
  if (accountsError) throw new Error(accountsError.message);
  const account = (accounts ?? []).find((a) => a.subtype === subtype || a.code === fallbackCode);
  if (!account) return { accountCode: null, balance: null };

  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  const entryIds = (entries ?? []).map((row) => row.id);
  if (!entryIds.length) return { accountCode: account.code, balance: 0 };

  const { data: lines, error: linesError } = await supabase
    .from("teller_journal_lines")
    .select("debit, credit")
    .eq("account_id", account.id)
    .in("entry_id", entryIds);
  if (linesError) throw new Error(linesError.message);

  const balance = (lines ?? []).reduce(
    (sum, line) => sum + Number(line.debit ?? 0) - Number(line.credit ?? 0),
    0,
  );
  return { accountCode: account.code, balance: Math.round(balance * 100) / 100 };
}

function amountsMatch(a, b) {
  if (a == null || b == null) return a === b;
  return Math.abs(Number(a) - Number(b)) <= 0.009;
}

function gitDeployedHint() {
  const result = spawnSync("git", ["log", "-1", "--format=%H %s", "origin/main"], {
    encoding: "utf8",
  });
  if (result.status === 0 && result.stdout.trim()) {
    const [commit, ...rest] = result.stdout.trim().split(" ");
    return { source: "origin/main", commit, message: rest.join(" ") };
  }
  const local = spawnSync("git", ["log", "-1", "--format=%H %s", "HEAD"], { encoding: "utf8" });
  if (local.status === 0 && local.stdout.trim()) {
    const [commit, ...rest] = local.stdout.trim().split(" ");
    return { source: "HEAD", commit, message: rest.join(" ") };
  }
  return null;
}

async function migrationMarker(supabase) {
  return {
    migration_023_document_sequences: await tableExists(supabase, "teller_document_sequences"),
    migration_024_fixed_assets: await tableExists(supabase, "teller_fixed_assets"),
    migration_022_purchase_orders: await tableExists(supabase, "teller_purchase_orders"),
    migration_021_ap_settings: await tableExists(supabase, "teller_ap_settings"),
    migration_018_bank_reconciliations: await tableExists(supabase, "teller_bank_reconciliations"),
    migration_009_banking: await tableExists(supabase, "teller_bank_connections"),
  };
}

async function phase8PreState(supabase) {
  const tables = {};
  for (const table of PHASE8_TABLES) {
    tables[table] = await tableExists(supabase, table);
  }
  const columns = {};
  for (const [table, column] of PHASE8_COLUMNS) {
    columns[`${table}.${column}`] = await columnExists(supabase, table, column);
  }
  const anyPresent = Object.values(tables).some(Boolean) || Object.values(columns).some(Boolean);
  return {
    tables,
    columns,
    teller_fixed_assets_absent: !tables.teller_fixed_assets,
    phase8SchemaAbsent: !anyPresent,
  };
}

async function countOrgDocumentsByKind(supabase, orgId, kind) {
  const { count, error } = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("kind", kind);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function demoOrgState(supabase, envKey, extraCounts) {
  const orgId = process.env[envKey]?.trim();
  if (!orgId) return { configured: false, envKey, organizationId: null };

  const journal = await journalIntegrity(supabase, orgId);
  const counts = {
    documents: await countRows(supabase, "teller_documents", orgId),
    journal_entries: journal.entryCount,
    journal_lines: journal.lineCount,
    jobs: await countRows(supabase, "teller_jobs", orgId),
    ...(await extraCounts(supabase, orgId)),
  };

  return { configured: true, envKey, organizationId: orgId, counts };
}

async function main() {
  loadControlledProdEnv();

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const capturedAt = new Date().toISOString();

  const [
    hfacDocumentsByKind,
    hfacJobs,
    hfacJournalIntegrity,
    hfacAr,
    hfacAp,
    globalJournal,
    phase8State,
    migrationMarkers,
    phase5Demo,
    phase6Demo,
    phase7Demo,
  ] = await Promise.all([
    documentsByKind(supabase, HFAC_ORG_ID),
    jobsByStatus(supabase, HFAC_ORG_ID),
    journalIntegrity(supabase, HFAC_ORG_ID),
    glBalanceForSubtype(supabase, HFAC_ORG_ID, "receivable", "1100"),
    glBalanceForSubtype(supabase, HFAC_ORG_ID, "payable", "2000"),
    globalJournalIntegrity(supabase),
    phase8PreState(supabase),
    migrationMarker(supabase),
    demoOrgState(supabase, "TELLER_PHASE5_DEMO_ORG_ID", async (client, orgId) => ({
      bank_connections: await countRows(client, "teller_bank_connections", orgId),
      bank_accounts: await countRows(client, "teller_bank_accounts", orgId),
      bank_transactions: await countRows(client, "teller_bank_transactions", orgId),
      bank_reconciliations: await countRows(client, "teller_bank_reconciliations", orgId),
    })),
    demoOrgState(supabase, "TELLER_PHASE6_DEMO_ORG_ID", async (client, orgId) => ({
      vendors: await vendorCount(client, orgId),
      purchase_orders: await countRows(client, "teller_purchase_orders", orgId),
      bills: await countOrgDocumentsByKind(client, orgId, "bill"),
    })),
    demoOrgState(supabase, "TELLER_PHASE7_DEMO_ORG_ID", async (client, orgId) => ({
      document_sequences: await countRows(client, "teller_document_sequences", orgId),
      job_budget_lines: await countRows(client, "teller_job_budget_lines", orgId),
    })),
  ]);

  const hfacVendors = await vendorCount(supabase, HFAC_ORG_ID);

  const hfacAccounting = {
    documents: await countRows(supabase, "teller_documents", HFAC_ORG_ID),
    documentsByKind: hfacDocumentsByKind,
    payments: await countRows(supabase, "teller_payments", HFAC_ORG_ID),
    payment_allocations: await countRows(supabase, "teller_payment_allocations", HFAC_ORG_ID),
    document_allocations: await countRows(supabase, "teller_document_allocations", HFAC_ORG_ID),
    journal_entries: hfacJournalIntegrity.entryCount,
    journal_lines: hfacJournalIntegrity.lineCount,
    balanced_journal_entries: hfacJournalIntegrity.balancedCount,
    unbalanced_journal_entries: hfacJournalIntegrity.unbalancedCount,
    ar_gl_balance: hfacAr.balance,
    ar_account_code: hfacAr.accountCode,
    ap_gl_balance: hfacAp.balance,
    ap_account_code: hfacAp.accountCode,
    vendors: hfacVendors,
  };

  const hfacJobsBaseline = {
    job_count: hfacJobs.total,
    jobs_by_status: hfacJobs.byStatus,
    jobs_with_external_source: hfacJobs.withExternal,
  };

  const hfacBaselineMatchesExpected =
    hfacAccounting.documents === EXPECTED_HFAC.documents &&
    hfacAccounting.payments === EXPECTED_HFAC.payments &&
    hfacAccounting.payment_allocations === EXPECTED_HFAC.payment_allocations &&
    hfacAccounting.document_allocations === EXPECTED_HFAC.document_allocations &&
    hfacAccounting.journal_entries === EXPECTED_HFAC.journal_entries &&
    hfacJobsBaseline.job_count === EXPECTED_HFAC.jobs &&
    hfacAccounting.vendors === EXPECTED_HFAC.vendors &&
    amountsMatch(hfacAccounting.ar_gl_balance, EXPECTED_HFAC.ar_gl_balance) &&
    amountsMatch(hfacAccounting.ap_gl_balance, EXPECTED_HFAC.ap_gl_balance);

  const productionJournalsBalanced =
    globalJournal.unbalancedCount === 0 && hfacJournalIntegrity.unbalancedCount === 0;

  const snapshot = {
    snapshotKind: "pre-phase8-production-baseline",
    capturedAt,
    projectRef: PROJECT_REF,
    hfacOrganizationId: HFAC_ORG_ID,
    protectedOrgNote: "HFAC org is read-only in this snapshot; never mutate in controlled demos",
    expectedHfacBaseline: EXPECTED_HFAC,
    hfacBaselineMatchesExpected,
    hfac: {
      accounting: hfacAccounting,
      jobs: hfacJobsBaseline,
    },
    demoOrgs: {
      phase5: phase5Demo,
      phase6: phase6Demo,
      phase7: phase7Demo,
    },
    production: {
      journal_entries: globalJournal.totalEntries,
      journal_lines: globalJournal.totalLines,
      balanced_journal_entries: globalJournal.balancedCount,
      unbalanced_journal_entries: globalJournal.unbalancedCount,
      journalsBalanced: productionJournalsBalanced,
    },
    phase8PreState: phase8State,
    schemaMarkers: migrationMarkers,
    deployedAppHint: gitDeployedHint(),
    gates: {
      PRE_PHASE8_SNAPSHOT_CREATED: true,
      HFAC_BASELINE_MATCHES_EXPECTED: hfacBaselineMatchesExpected,
      PHASE8_SCHEMA_CURRENTLY_ABSENT: phase8State.phase8SchemaAbsent,
      PRODUCTION_JOURNALS_BALANCED: productionJournalsBalanced,
    },
    recoveryNotes: {
      readOnlySnapshot: true,
      migration024NotApplied: phase8State.phase8SchemaAbsent,
      phase8CodeNotDeployed: true,
    },
  };

  if (!hfacBaselineMatchesExpected) {
    snapshot.gates.STOP_REASON = "HFAC baseline differs from expected pre-Phase 8 counts";
    snapshot.gates.actualVsExpected = {
      expected: EXPECTED_HFAC,
      actual: {
        documents: hfacAccounting.documents,
        payments: hfacAccounting.payments,
        payment_allocations: hfacAccounting.payment_allocations,
        document_allocations: hfacAccounting.document_allocations,
        journal_entries: hfacAccounting.journal_entries,
        jobs: hfacJobsBaseline.job_count,
        vendors: hfacAccounting.vendors,
        ar_gl_balance: hfacAccounting.ar_gl_balance,
        ap_gl_balance: hfacAccounting.ap_gl_balance,
      },
    };
  }

  const dir = resolve(process.cwd(), "artifacts/controlled-prod-snapshots");
  mkdirSync(dir, { recursive: true });
  const stamp = capturedAt.replace(/[:.]/g, "-");
  const jsonPath = resolve(dir, `pre-phase8-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));

  let safeToApply = false;
  try {
    const audit = spawnSync("node", ["scripts/audit-phase8-deployment-compat.mjs"], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    const jsonStart = audit.stdout.indexOf("{");
    if (jsonStart >= 0) {
      safeToApply = JSON.parse(audit.stdout.slice(jsonStart)).SAFE_TO_APPLY_024 === true;
    }
  } catch {
    safeToApply = false;
  }
  snapshot.gates.SAFE_TO_APPLY_024 = safeToApply;

  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));

  console.log(
    JSON.stringify(
      {
        PRE_PHASE8_SNAPSHOT_CREATED: true,
        SNAPSHOT_PATH: jsonPath,
        HFAC_BASELINE_MATCHES_EXPECTED: hfacBaselineMatchesExpected,
        PHASE8_SCHEMA_CURRENTLY_ABSENT: phase8State.phase8SchemaAbsent,
        PRODUCTION_JOURNALS_BALANCED: productionJournalsBalanced,
        SAFE_TO_APPLY_024: safeToApply,
        ...(hfacBaselineMatchesExpected
          ? {}
          : { STOP: true, reason: snapshot.gates.STOP_REASON, actualVsExpected: snapshot.gates.actualVsExpected }),
      },
      null,
      2,
    ),
  );

  process.exit(hfacBaselineMatchesExpected ? 0 : 2);
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        PRE_PHASE8_SNAPSHOT_CREATED: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
