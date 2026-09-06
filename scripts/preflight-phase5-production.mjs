#!/usr/bin/env node
/**
 * Read-only Phase 5 pre-flight against production (ypixbxicdecwfafculha).
 * Usage: TELLER_CONTROLLED_PROD_TEST=1 node scripts/preflight-phase5-production.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const PRODUCTION_REF = "ypixbxicdecwfafculha";
const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";

const PHASE5_TABLES = [
  "teller_bank_matches",
  "teller_bank_transaction_splits",
  "teller_bank_transfers",
  "teller_bank_reconciliations",
  "teller_bank_reconciliation_items",
  "teller_bank_import_batches",
];

const PHASE5_RPCS = [
  "teller_import_bank_transactions",
  "teller_confirm_bank_match",
  "teller_remove_bank_match",
  "teller_exclude_bank_transaction",
  "teller_categorize_bank_transaction",
  "teller_split_categorize_bank_transaction",
  "teller_create_bank_transfer",
  "teller_finalize_bank_reconciliation",
  "teller_reopen_bank_reconciliation",
];

const PHASE4_RPCS = [
  "teller_reverse_payment",
  "teller_reverse_deposit_application",
  "teller_reverse_document_allocation",
  "teller_refund_customer_deposit",
  "teller_refund_customer_credit",
  "teller_write_off_invoice",
];

async function countRows(supabase, table, orgId = null) {
  let query = supabase.from(table).select("id", { count: "exact", head: true });
  if (orgId) query = query.eq("organization_id", orgId);
  const { count, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function tableExists(supabase, table) {
  const { error } = await supabase.from(table).select("id", { count: "exact", head: true });
  if (!error) return true;
  const message = error.message.toLowerCase();
  return !message.includes("does not exist") && !message.includes("could not find");
}

async function rpcExists(supabase, name) {
  const { error } = await supabase.rpc(name, {});
  if (!error) return true;
  const message = error.message.toLowerCase();
  if (message.includes("does not exist") || message.includes("could not find")) return false;
  return true;
}

async function journalBalanceCheck(supabase, orgId) {
  const { data: entries, error } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  const entryIds = (entries ?? []).map((row) => row.id);
  if (!entryIds.length) return { balanced: true, entryCount: 0 };

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

  const unbalanced = [...byEntry.entries()].filter(
    ([, totals]) => Math.abs(totals.debit - totals.credit) > 0.009,
  );

  return {
    balanced: unbalanced.length === 0,
    entryCount: entryIds.length,
    unbalancedEntryIds: unbalanced.map(([id]) => id),
  };
}

async function orphanAllocationProbe(supabase, orgId) {
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

async function accountBalances(supabase, orgId) {
  const { data: accounts, error: accountsError } = await supabase
    .from("teller_accounts")
    .select("id, code, name, type, subtype")
    .eq("organization_id", orgId)
    .order("code");
  if (accountsError) throw new Error(accountsError.message);

  const { data: entries, error: entriesError } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  if (entriesError) throw new Error(entriesError.message);

  const entryIds = (entries ?? []).map((row) => row.id);
  let lines = [];
  if (entryIds.length) {
    const { data, error: linesError } = await supabase
      .from("teller_journal_lines")
      .select("account_id, debit, credit")
      .in("entry_id", entryIds);
    if (linesError) throw new Error(linesError.message);
    lines = data ?? [];
  }

  const balanceByAccount = new Map();
  for (const line of lines) {
    const current = balanceByAccount.get(line.account_id) ?? 0;
    balanceByAccount.set(
      line.account_id,
      current + Number(line.debit ?? 0) - Number(line.credit ?? 0),
    );
  }

  return (accounts ?? []).map((account) => ({
    code: account.code,
    name: account.name,
    type: account.type,
    subtype: account.subtype,
    balance: Math.round((balanceByAccount.get(account.id) ?? 0) * 100) / 100,
  }));
}

async function main() {
  const env = loadControlledProdEnv();
  if (env.projectRef !== PRODUCTION_REF) {
    throw new Error(`Expected production ref ${PRODUCTION_REF}`);
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const phase5Tables = {};
  for (const table of PHASE5_TABLES) {
    phase5Tables[table] = await tableExists(supabase, table);
  }

  const phase5Rpcs = {};
  for (const rpc of PHASE5_RPCS) {
    phase5Rpcs[rpc] = await rpcExists(supabase, rpc);
  }

  const phase4Rpcs = {};
  for (const rpc of PHASE4_RPCS) {
    phase4Rpcs[rpc] = await rpcExists(supabase, rpc);
  }

  const banking = {
    connections: await countRows(supabase, "teller_bank_connections"),
    accounts: await countRows(supabase, "teller_bank_accounts"),
    transactions: await countRows(supabase, "teller_bank_transactions"),
    legacyMatched: 0,
  };

  const { data: legacyMatches } = await supabase
    .from("teller_bank_transactions")
    .select("id, matched_document_id, matched_journal_entry_id")
    .or("matched_document_id.not.is.null,matched_journal_entry_id.not.is.null");
  banking.legacyMatched = legacyMatches?.length ?? 0;

  const hfacBalances = await accountBalances(supabase, HFAC_ORG_ID);
  const arAccount = hfacBalances.find((row) => row.subtype === "receivable" || row.code === "1100");
  const apAccount = hfacBalances.find((row) => row.subtype === "payable" || row.code === "2000");

  const hfac = {
    counts: {
      documents: await countRows(supabase, "teller_documents", HFAC_ORG_ID),
      payments: await countRows(supabase, "teller_payments", HFAC_ORG_ID),
      payment_allocations: await countRows(supabase, "teller_payment_allocations", HFAC_ORG_ID),
      journal_entries: await countRows(supabase, "teller_journal_entries", HFAC_ORG_ID),
      journal_lines: await countRows(supabase, "teller_journal_lines"),
    },
    arGlBalance: arAccount?.balance ?? null,
    apGlBalance: apAccount?.balance ?? null,
    journalBalance: await journalBalanceCheck(supabase, HFAC_ORG_ID),
    orphanAllocations: await orphanAllocationProbe(supabase, HFAC_ORG_ID),
  };

  const report = {
    capturedAt: new Date().toISOString(),
    projectRef: PRODUCTION_REF,
    hfacOrganizationId: HFAC_ORG_ID,
    migrations018To020Present: Object.values(phase5Tables).some(Boolean),
    phase5Tables,
    phase5Rpcs,
    phase4Rpcs,
    banking,
    hfac,
    readyForPhase5Migration:
      !Object.values(phase5Tables).some(Boolean) &&
      !Object.values(phase5Rpcs).some(Boolean),
  };

  const dir = resolve(process.cwd(), "artifacts/controlled-prod-snapshots");
  mkdirSync(dir, { recursive: true });
  const stamp = report.capturedAt.replace(/[:.]/g, "-");
  const jsonPath = resolve(dir, `pre-phase5-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({ ok: true, jsonPath, report }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
