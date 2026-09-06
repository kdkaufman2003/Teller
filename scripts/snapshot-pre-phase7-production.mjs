#!/usr/bin/env node
/**
 * Step A — read-only pre-Phase 7 production baseline snapshot.
 * Usage: TELLER_CONTROLLED_PROD_TEST=1 node scripts/snapshot-pre-phase7-production.mjs
 *
 * Does NOT apply migration 023, deploy code, or mutate production data.
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
  journal_entries: 16,
  jobs: 0,
};

const PHASE7_TABLES = [
  "teller_document_sequences",
  "teller_job_cost_categories",
  "teller_job_budget_lines",
];

const PHASE7_COLUMNS = [
  ["teller_jobs", "estimated_revenue"],
  ["teller_jobs", "closed_at"],
  ["teller_document_lines", "cost_classification"],
  ["teller_journal_lines", "cost_classification"],
  ["teller_journal_lines", "job_cost_category_id"],
];

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

async function rpcExists(supabase, name) {
  const { error } = await supabase.rpc(name, {
    p_organization_id: HFAC_ORG_ID,
    p_sequence_key: "probe",
    p_default_prefix: "JOB",
  });
  if (!error) return true;
  const msg = (error.message ?? "").toLowerCase();
  if (msg.includes("does not exist") || msg.includes("could not find the function")) return false;
  // Any other error (auth, validation) implies the function exists.
  return true;
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

async function orphanPaymentAllocations(supabase, orgId) {
  const { data: allocations, error } = await supabase
    .from("teller_payment_allocations")
    .select("id, payment_id, document_id")
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  if (!allocations?.length) return 0;

  const paymentIds = [...new Set(allocations.map((row) => row.payment_id))];
  const documentIds = [...new Set(allocations.map((row) => row.document_id))];
  const [{ data: payments }, { data: documents }] = await Promise.all([
    supabase.from("teller_payments").select("id").in("id", paymentIds),
    supabase.from("teller_documents").select("id").in("id", documentIds),
  ]);
  const paymentSet = new Set((payments ?? []).map((row) => row.id));
  const documentSet = new Set((documents ?? []).map((row) => row.id));
  return allocations.filter(
    (row) => !paymentSet.has(row.payment_id) || !documentSet.has(row.document_id),
  ).length;
}

async function orphanDocumentAllocations(supabase, orgId) {
  const { data: allocations, error } = await supabase
    .from("teller_document_allocations")
    .select("id, source_document_id, target_document_id")
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  if (!allocations?.length) return 0;

  let orphans = 0;
  for (const row of allocations) {
    const [{ data: source }, { data: target }] = await Promise.all([
      supabase.from("teller_documents").select("id").eq("id", row.source_document_id).maybeSingle(),
      supabase.from("teller_documents").select("id").eq("id", row.target_document_id).maybeSingle(),
    ]);
    if (!source || !target) orphans += 1;
  }
  return orphans;
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

async function countReconciliationsByStatus(supabase, orgId) {
  const { data, error } = await supabase
    .from("teller_bank_reconciliations")
    .select("status")
    .eq("organization_id", orgId);
  if (error) {
    const msg = (error.message ?? "").toLowerCase();
    if (msg.includes("does not exist")) return null;
    throw new Error(error.message);
  }
  const counts = { total: (data ?? []).length, completed: 0, byStatus: {} };
  for (const row of data ?? []) {
    const status = row.status || "unknown";
    counts.byStatus[status] = (counts.byStatus[status] ?? 0) + 1;
    if (status === "completed") counts.completed += 1;
  }
  return counts;
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
    migration_021_ap_settings: await tableExists(supabase, "teller_ap_settings"),
    migration_022_purchase_orders: await tableExists(supabase, "teller_purchase_orders"),
    migration_023_document_sequences: await tableExists(supabase, "teller_document_sequences"),
    migration_018_bank_reconciliations: await tableExists(supabase, "teller_bank_reconciliations"),
    migration_009_banking: await tableExists(supabase, "teller_bank_connections"),
  };
}

async function phase7PreState(supabase) {
  const tables = {};
  for (const table of PHASE7_TABLES) {
    tables[table] = await tableExists(supabase, table);
  }
  const columns = {};
  for (const [table, column] of PHASE7_COLUMNS) {
    columns[`${table}.${column}`] = await columnExists(supabase, table, column);
  }
  const rpc = await rpcExists(supabase, "teller_allocate_sequence_number");
  const anyPresent =
    Object.values(tables).some(Boolean) ||
    Object.values(columns).some(Boolean) ||
    rpc;
  return {
    tables,
    columns,
    teller_allocate_sequence_number: rpc,
    phase7SchemaAbsent: !anyPresent,
  };
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
    hfacOrphanPayments,
    hfacOrphanDocs,
    hfacAr,
    hfacAp,
    globalJournal,
    phase7State,
    migrationMarkers,
    hfacReconciliations,
  ] = await Promise.all([
    documentsByKind(supabase, HFAC_ORG_ID),
    jobsByStatus(supabase, HFAC_ORG_ID),
    journalIntegrity(supabase, HFAC_ORG_ID),
    orphanPaymentAllocations(supabase, HFAC_ORG_ID),
    orphanDocumentAllocations(supabase, HFAC_ORG_ID),
    glBalanceForSubtype(supabase, HFAC_ORG_ID, "receivable", "1100"),
    glBalanceForSubtype(supabase, HFAC_ORG_ID, "payable", "2000"),
    globalJournalIntegrity(supabase),
    phase7PreState(supabase),
    migrationMarker(supabase),
    countReconciliationsByStatus(supabase, HFAC_ORG_ID),
  ]);

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
    orphan_payment_allocations: hfacOrphanPayments,
    orphan_document_allocations: hfacOrphanDocs,
  };

  const hfacJobsBaseline = {
    job_count: hfacJobs.total,
    jobs_by_status: hfacJobs.byStatus,
    jobs_with_external_source: hfacJobs.withExternal,
  };

  const hfacPhase5 = {
    bank_connections: await countRows(supabase, "teller_bank_connections", HFAC_ORG_ID),
    bank_accounts: await countRows(supabase, "teller_bank_accounts", HFAC_ORG_ID),
    bank_transactions: await countRows(supabase, "teller_bank_transactions", HFAC_ORG_ID),
    bank_matches: await countRows(supabase, "teller_bank_matches", HFAC_ORG_ID),
    reconciliations: hfacReconciliations?.total ?? await countRows(supabase, "teller_bank_reconciliations", HFAC_ORG_ID),
    completed_reconciliations: hfacReconciliations?.completed ?? null,
    reconciliations_by_status: hfacReconciliations?.byStatus ?? null,
  };

  const hfacPhase6 = {
    vendors: await (async () => {
      const { count, error } = await supabase
        .from("teller_parties")
        .select("*", { count: "exact", head: true })
        .eq("organization_id", HFAC_ORG_ID)
        .in("kind", ["vendor", "both"]);
      if (error) throw new Error(`teller_parties vendors: ${error.message}`);
      return count ?? 0;
    })(),
    purchase_orders: await countRows(supabase, "teller_purchase_orders", HFAC_ORG_ID),
    purchase_order_lines: await countRows(supabase, "teller_purchase_order_lines", HFAC_ORG_ID),
    purchase_receipts: await countRows(supabase, "teller_purchase_receipts", HFAC_ORG_ID),
    purchase_receipt_lines: await countRows(supabase, "teller_purchase_receipt_lines", HFAC_ORG_ID),
    bills: await countOrgDocumentsByKind(supabase, HFAC_ORG_ID, "bill"),
    vendor_credits: await countOrgDocumentsByKind(supabase, HFAC_ORG_ID, "vendor_credit"),
    recurring_bill_templates: await countRows(supabase, "teller_recurring_bill_templates", HFAC_ORG_ID),
    ap_settings: await countRows(supabase, "teller_ap_settings", HFAC_ORG_ID),
  };

  const hfacBaselineMatchesExpected =
    hfacAccounting.documents === EXPECTED_HFAC.documents &&
    hfacAccounting.payments === EXPECTED_HFAC.payments &&
    hfacAccounting.payment_allocations === EXPECTED_HFAC.payment_allocations &&
    hfacAccounting.journal_entries === EXPECTED_HFAC.journal_entries &&
    hfacJobsBaseline.job_count === EXPECTED_HFAC.jobs;

  const productionJournalsBalanced =
    globalJournal.unbalancedCount === 0 && hfacJournalIntegrity.unbalancedCount === 0;

  const snapshot = {
    snapshotKind: "pre-phase7-production-baseline",
    capturedAt,
    projectRef: PROJECT_REF,
    hfacOrganizationId: HFAC_ORG_ID,
    protectedOrgNote: "HFAC org is read-only in this snapshot; never mutate in controlled demos",
    expectedHfacBaseline: EXPECTED_HFAC,
    hfacBaselineMatchesExpected,
    hfac: {
      accounting: hfacAccounting,
      jobs: hfacJobsBaseline,
      phase5Banking: hfacPhase5,
      phase6ApPurchasing: hfacPhase6,
    },
    production: {
      journal_entries: globalJournal.totalEntries,
      journal_lines: globalJournal.totalLines,
      balanced_journal_entries: globalJournal.balancedCount,
      unbalanced_journal_entries: globalJournal.unbalancedCount,
      journalsBalanced: productionJournalsBalanced,
    },
    phase7PreState: phase7State,
    schemaMarkers: migrationMarkers,
    deployedAppHint: gitDeployedHint(),
    gates: {
      PRE_PHASE7_SNAPSHOT_CREATED: true,
      HFAC_BASELINE_MATCHES_EXPECTED: hfacBaselineMatchesExpected,
      HFAC_JOB_COUNT: hfacJobsBaseline.job_count,
      PHASE7_SCHEMA_CURRENTLY_ABSENT: phase7State.phase7SchemaAbsent,
      PRODUCTION_JOURNALS_BALANCED: productionJournalsBalanced,
    },
    recoveryNotes: {
      readOnlySnapshot: true,
      migration023NotApplied: true,
      phase7CodeNotDeployed: true,
    },
  };

  if (!hfacBaselineMatchesExpected) {
    snapshot.gates.STOP_REASON = "HFAC baseline differs from expected Phase 6 verification counts";
    snapshot.gates.actualVsExpected = {
      expected: EXPECTED_HFAC,
      actual: {
        documents: hfacAccounting.documents,
        payments: hfacAccounting.payments,
        payment_allocations: hfacAccounting.payment_allocations,
        journal_entries: hfacAccounting.journal_entries,
        jobs: hfacJobsBaseline.job_count,
      },
    };
  }

  const dir = resolve(process.cwd(), "artifacts/controlled-prod-snapshots");
  mkdirSync(dir, { recursive: true });
  const stamp = capturedAt.replace(/[:.]/g, "-");
  const jsonPath = resolve(dir, `pre-phase7-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));

  let safeToApply = false;
  try {
    const audit = spawnSync("node", ["scripts/audit-phase7-deployment-compat.mjs"], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    const jsonStart = audit.stdout.indexOf("{");
    if (jsonStart >= 0) {
      safeToApply = JSON.parse(audit.stdout.slice(jsonStart)).SAFE_TO_APPLY_023 === true;
    }
  } catch {
    safeToApply = false;
  }
  snapshot.gates.SAFE_TO_APPLY_023 = safeToApply;

  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));

  console.log(
    JSON.stringify(
      {
        PRE_PHASE7_SNAPSHOT_CREATED: true,
        SNAPSHOT_PATH: jsonPath,
        HFAC_BASELINE_MATCHES_EXPECTED: hfacBaselineMatchesExpected,
        HFAC_JOB_COUNT: hfacJobsBaseline.job_count,
        PHASE7_SCHEMA_CURRENTLY_ABSENT: phase7State.phase7SchemaAbsent,
        PRODUCTION_JOURNALS_BALANCED: productionJournalsBalanced,
        SAFE_TO_APPLY_023: safeToApply,
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
        PRE_PHASE7_SNAPSHOT_CREATED: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
