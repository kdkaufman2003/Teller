#!/usr/bin/env node
/** Read-only Phase 16C pre-migration production snapshot (no secrets). */
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG = "812be00d-3084-4227-ac71-ccbd22e4172c";

async function countTable(supabase, table) {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });
  if (error) return { error: error.message };
  return count ?? 0;
}

async function orgCount(supabase, table, orgId) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (error) return { error: error.message };
  return count ?? 0;
}

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { count: unbalanced } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .neq("is_balanced", true);

  const { data: lineTotals } = await supabase.rpc("teller_default_legal_entity_id", {
    p_org_id: HFAC_ORG,
  }).then(() => ({ data: null })).catch(() => ({ data: null }));

  void lineTotals;

  const { data: debitCredit } = await supabase
    .from("teller_journal_lines")
    .select("debit, credit")
    .limit(50000);

  let debitSum = 0;
  let creditSum = 0;
  for (const row of debitCredit ?? []) {
    debitSum += Number(row.debit ?? 0);
    creditSum += Number(row.credit ?? 0);
  }

  const snapshot = {
    capturedAt: new Date().toISOString(),
    organizations: await countTable(supabase, "teller_organizations"),
    legalEntities: await countTable(supabase, "teller_legal_entities"),
    accounts: await countTable(supabase, "teller_accounts"),
    journalEntries: await countTable(supabase, "teller_journal_entries"),
    journalLineDebitTotalSample: debitSum,
    journalLineCreditTotalSample: creditSum,
    bankAccounts: await countTable(supabase, "teller_bank_accounts"),
    documents: await countTable(supabase, "teller_documents"),
    payments: await countTable(supabase, "teller_payments"),
    periodCloseEvents: await countTable(supabase, "teller_period_closes"),
    unbalancedJournals: unbalanced ?? 0,
    hfac: {
      documents: await orgCount(supabase, "teller_documents", HFAC_ORG),
      journals: await orgCount(supabase, "teller_journal_entries", HFAC_ORG),
      payments: await orgCount(supabase, "teller_payments", HFAC_ORG),
      allocations: await orgCount(supabase, "teller_payment_allocations", HFAC_ORG),
      taxTransactions: await orgCount(supabase, "teller_tax_transactions", HFAC_ORG),
    },
  };

  console.log(JSON.stringify({ PHASE16C_SNAPSHOT: snapshot }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
