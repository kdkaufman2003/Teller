#!/usr/bin/env node
/**
 * Read-only Phase 5 post-migration verification against production.
 * Usage: TELLER_CONTROLLED_PROD_TEST=1 node scripts/verify-phase5-production.mjs
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
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

const PHASE5_COLUMNS = [
  ["teller_bank_transactions", "normalized_amount"],
  ["teller_bank_transactions", "status"],
  ["teller_bank_transactions", "import_fingerprint"],
  ["teller_bank_accounts", "gl_account_id"],
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

async function countRows(supabase, table, orgId = null) {
  let query = supabase.from(table).select("id", { count: "exact", head: true });
  if (orgId) query = query.eq("organization_id", orgId);
  const { count, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function rpcExists(supabase, name) {
  const { error } = await supabase.rpc(name, {});
  if (!error) return true;
  const message = error.message.toLowerCase();
  if (message.includes("without parameters")) return true;
  if (message.includes("does not exist")) return false;
  if (message.includes("could not find the function")) return false;
  return true;
}

async function journalBalanceCheck(supabase, orgId) {
  const { data: entries, error } = await supabase
    .from("teller_journal_entries")
    .select("id, source_kind, created_at")
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);

  const entryIds = (entries ?? []).map((row) => row.id);
  if (!entryIds.length) return { balanced: true, entryCount: 0, phase5JournalCount: 0 };

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

  const phase5JournalCount = (entries ?? []).filter((row) => {
    const kind = String(row.source_kind ?? "");
    return kind.startsWith("bank-") || kind === "bank-transfer";
  }).length;

  return {
    balanced: unbalanced.length === 0,
    entryCount: entryIds.length,
    phase5JournalCount,
    unbalancedEntryIds: unbalanced.map(([id]) => id),
  };
}

function loadBaseline() {
  const dir = resolve(process.cwd(), "artifacts/controlled-prod-snapshots");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.startsWith("pre-phase5-") && name.endsWith(".json"))
    .sort();
  if (!files.length) return null;
  return JSON.parse(readFileSync(resolve(dir, files[files.length - 1]), "utf8"));
}

async function main() {
  loadControlledProdEnv();

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const checks = [];

  for (const table of PHASE5_TABLES) {
    const { error } = await supabase.from(table).select("id").limit(0);
    checks.push({ name: `${table} exists`, pass: !error, detail: error?.message ?? "ok" });
  }

  for (const [table, column] of PHASE5_COLUMNS) {
    const { error } = await supabase.from(table).select(column).limit(0);
    checks.push({ name: `${table}.${column}`, pass: !error, detail: error?.message ?? "ok" });
  }

  for (const rpc of PHASE5_RPCS) {
    const exists = await rpcExists(supabase, rpc);
    checks.push({ name: `rpc ${rpc}`, pass: exists, detail: exists ? "present" : "missing" });
  }

  const hfacBefore = loadBaseline();
  void hfacBefore;

  const hfacCounts = {
    documents: await countRows(supabase, "teller_documents", HFAC_ORG_ID),
    payments: await countRows(supabase, "teller_payments", HFAC_ORG_ID),
    payment_allocations: await countRows(supabase, "teller_payment_allocations", HFAC_ORG_ID),
    journal_entries: await countRows(supabase, "teller_journal_entries", HFAC_ORG_ID),
  };

  const journalBalance = await journalBalanceCheck(supabase, HFAC_ORG_ID);
  checks.push({
    name: "HFAC journals balanced",
    pass: journalBalance.balanced,
    detail: JSON.stringify(journalBalance),
  });
  checks.push({
    name: "No Phase 5 journals created by migration alone",
    pass: journalBalance.phase5JournalCount === 0,
    detail: `phase5JournalCount=${journalBalance.phase5JournalCount}`,
  });

  const banking = {
    connections: await countRows(supabase, "teller_bank_connections"),
    accounts: await countRows(supabase, "teller_bank_accounts"),
    transactions: await countRows(supabase, "teller_bank_transactions"),
    matches: await countRows(supabase, "teller_bank_matches"),
  };

  const allPass = checks.every((check) => check.pass);
  console.log(
    JSON.stringify(
      {
        allPass,
        projectRef: PRODUCTION_REF,
        hfacOrganizationId: HFAC_ORG_ID,
        hfacCounts,
        banking,
        checks,
        note: "Compare hfacCounts to pre-phase5 snapshot from preflight-phase5-production.mjs",
      },
      null,
      2,
    ),
  );
  if (!allPass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
