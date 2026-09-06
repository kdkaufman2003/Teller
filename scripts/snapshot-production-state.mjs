#!/usr/bin/env node
/**
 * Read-only production snapshot before controlled Phase 4 work.
 * Usage: TELLER_CONTROLLED_PROD_TEST=1 node scripts/snapshot-production-state.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG_ID = "812be00d-3084-4227-ac71-ccbd22e4172c";

async function countRows(supabase, table, orgId = null) {
  let query = supabase.from(table).select("id", { count: "exact", head: true });
  if (orgId) query = query.eq("organization_id", orgId);
  const { count, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function countJournalLinesForOrg(supabase, orgId) {
  const { data: entries, error: entriesError } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  if (entriesError) throw new Error(`teller_journal_entries: ${entriesError.message}`);
  const entryIds = (entries ?? []).map((row) => row.id);
  if (entryIds.length === 0) return 0;
  const { count, error } = await supabase
    .from("teller_journal_lines")
    .select("id", { count: "exact", head: true })
    .in("entry_id", entryIds);
  if (error) throw new Error(`teller_journal_lines: ${error.message}`);
  return count ?? 0;
}

async function sumColumn(supabase, table, column, orgId) {
  const { data, error } = await supabase
    .from(table)
    .select(column)
    .eq("organization_id", orgId);
  if (error) throw new Error(`${table}.${column}: ${error.message}`);
  return (data ?? []).reduce((sum, row) => sum + Number(row[column] ?? 0), 0);
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
  if (entryIds.length > 0) {
    const { data, error: linesError } = await supabase
      .from("teller_journal_lines")
      .select("account_id, debit, credit, entry_id")
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
  loadControlledProdEnv();

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: orgs, error: orgsError } = await supabase
    .from("teller_organizations")
    .select("id, name, legal_name, industry_id, setup_completed_at")
    .order("name");
  if (orgsError) throw new Error(orgsError.message);

  const globalCounts = {
    organizations: await countRows(supabase, "teller_organizations"),
    accounts: await countRows(supabase, "teller_accounts"),
    documents: await countRows(supabase, "teller_documents"),
    payments: await countRows(supabase, "teller_payments"),
    payment_allocations: await countRows(supabase, "teller_payment_allocations"),
    document_allocations: await countRows(supabase, "teller_document_allocations"),
    journal_entries: await countRows(supabase, "teller_journal_entries"),
    journal_lines: await countRows(supabase, "teller_journal_lines"),
    parties: await countRows(supabase, "teller_parties"),
  };

  const writeOffsProbe = await supabase.from("teller_write_offs").select("id").limit(1);
  globalCounts.write_offs = writeOffsProbe.error ? null : 0;
  globalCounts.write_offs_table_exists = !writeOffsProbe.error;
  globalCounts.migration_017_applied =
    !writeOffsProbe.error &&
    !(await supabase.from("teller_payment_allocations").select("reversal_of_allocation_id").limit(1))
      .error;

  const hfacCounts = {
    documents: await countRows(supabase, "teller_documents", HFAC_ORG_ID),
    payments: await countRows(supabase, "teller_payments", HFAC_ORG_ID),
    payment_allocations: await countRows(supabase, "teller_payment_allocations", HFAC_ORG_ID),
    journal_entries: await countRows(supabase, "teller_journal_entries", HFAC_ORG_ID),
    journal_lines: await countJournalLinesForOrg(supabase, HFAC_ORG_ID),
    parties: await countRows(supabase, "teller_parties", HFAC_ORG_ID),
    accounts: await countRows(supabase, "teller_accounts", HFAC_ORG_ID),
    invoice_total: await sumColumn(supabase, "teller_documents", "total", HFAC_ORG_ID),
    amount_paid_total: await sumColumn(supabase, "teller_documents", "amount_paid", HFAC_ORG_ID),
  };

  const hfacBalances = await accountBalances(supabase, HFAC_ORG_ID);
  const arAccount = hfacBalances.find(
    (row) => row.subtype === "receivable" || row.code === "1100",
  );
  const apAccount = hfacBalances.find(
    (row) => row.subtype === "payable" || row.code === "2000",
  );

  const snapshot = {
    capturedAt: new Date().toISOString(),
    projectRef: "ypixbxicdecwfafculha",
    hfacOrganizationId: HFAC_ORG_ID,
    organizations: orgs ?? [],
    globalCounts,
    hfac: {
      counts: hfacCounts,
      arGlBalance: arAccount?.balance ?? null,
      apGlBalance: apAccount?.balance ?? null,
      accountBalances: hfacBalances,
    },
    recoveryNotes: {
      gitRevertRestoresCodeOnly: true,
      databaseRecoveryRequiresBackupOrCorrectiveMigration: true,
      supabaseDashboardBackups:
        "Supabase Pro/Team plans include daily backups and PITR; Free tier relies on manual exports — verify plan in Supabase dashboard.",
    },
  };

  const dir = resolve(process.cwd(), "artifacts/controlled-prod-snapshots");
  mkdirSync(dir, { recursive: true });
  const stamp = snapshot.capturedAt.replace(/[:.]/g, "-");
  const jsonPath = resolve(dir, `pre-phase4-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));

  console.log(JSON.stringify({ ok: true, jsonPath, summary: snapshot }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
