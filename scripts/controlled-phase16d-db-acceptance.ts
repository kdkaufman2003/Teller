/**
 * Phase 16D controlled DB acceptance — requires manually applied migration 044.
 * Mutates dedicated Phase 16 demo org only. HFAC org is read-only baseline.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import {
  getIntercompanyPairBalance,
  postExpenseOnBehalf,
  postIntercompanyFundTransfer,
  reverseIntercompanyTransaction,
} from "../src/lib/accounting/intercompany";
import { nextCloseablePeriodEnd } from "../src/lib/accounting/periods";
import { initializeEntityCoa } from "../src/lib/accounting/entity-books";
import { createLegalEntity } from "../src/lib/accounting/legal-entity";
import { PHASE16_BRANCH_ENTITY_CODE } from "./phase16-controlled-fixture.mjs";

type Result = { name: string; pass: boolean; detail?: string };

const HFAC_ORG = TELLER_HFAC_ORG_ID;
const ACCEPT_MEMO = "16D_ACCEPT";

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST=1 required");
  }
  const orgId = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim();
  const foreignOrgId = process.env.TELLER_PHASE16_FOREIGN_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE16_DEMO_ORG_ID missing");
  if (!foreignOrgId) throw new Error("TELLER_PHASE16_FOREIGN_ORG_ID missing");
  assertNotHfacOrganization(orgId);
  assertNotHfacOrganization(foreignOrgId);
  return {
    orgId,
    foreignOrgId,
    supabase: createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
  };
}

async function assertSchemaReady(supabase: SupabaseClient) {
  const { error } = await supabase.from("teller_intercompany_transactions").select("id").limit(1);
  if (error?.message.match(/does not exist|schema cache/i)) {
    throw new Error("Migration 044 not applied — teller_intercompany_transactions missing");
  }
}

async function ensureCoa(supabase: SupabaseClient, orgId: string, legalEntityId: string) {
  const { count } = await supabase
    .from("teller_accounts")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("legal_entity_id", legalEntityId);
  if ((count ?? 0) === 0) {
    await initializeEntityCoa(supabase, { organizationId: orgId, legalEntityId, mode: "standard" });
  }
}

async function requireEntityByCode(supabase: SupabaseClient, orgId: string, entityCode: string) {
  const { data, error } = await supabase
    .from("teller_legal_entities")
    .select("id, entity_code, is_default")
    .eq("organization_id", orgId)
    .eq("entity_code", entityCode)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error(`entity ${entityCode} missing`);
  return data;
}

async function assertJournalUsesEntityAccounts(
  supabase: SupabaseClient,
  entryId: string,
  expectedLegalEntityId: string,
) {
  const { data: lines, error: lineError } = await supabase
    .from("teller_journal_lines")
    .select("account_id")
    .eq("entry_id", entryId);
  if (lineError) throw new Error(lineError.message);
  const accountIds = (lines ?? []).map((line) => line.account_id as string);
  if (!accountIds.length) throw new Error("journal has no lines");
  const { data: accounts, error: accountError } = await supabase
    .from("teller_accounts")
    .select("id, legal_entity_id")
    .in("id", accountIds);
  if (accountError) throw new Error(accountError.message);
  if (
    accounts?.some((account) => account.legal_entity_id !== expectedLegalEntityId)
  ) {
    throw new Error("cross-entity account on journal");
  }
}

async function accountByCode(
  supabase: SupabaseClient,
  orgId: string,
  legalEntityId: string,
  code: string,
) {
  const { data, error } = await supabase
    .from("teller_accounts")
    .select("id, code, legal_entity_id, type, subtype")
    .eq("organization_id", orgId)
    .eq("legal_entity_id", legalEntityId)
    .eq("code", code)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error(`account ${code} missing`);
  return data;
}

async function booksClosedThrough(supabase: SupabaseClient, orgId: string, entityId: string) {
  const { data, error } = await supabase.rpc("teller_books_closed_through", {
    p_org: orgId,
    p_legal_entity_id: entityId,
  });
  if (error) throw new Error(error.message);
  return (data as string | null) ?? null;
}

function dayAfter(iso: string) {
  const d = new Date(iso.slice(0, 10) + "T12:00:00");
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function priorMonthEnd(isoDate: string): string {
  const d = new Date(isoDate.slice(0, 10) + "T12:00:00");
  d.setDate(0);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const { orgId, foreignOrgId, supabase } = loadEnv();
  await assertSchemaReady(supabase);

  const mainEntity = await requireEntityByCode(supabase, orgId, "MAIN");
  let branchEntity = await requireEntityByCode(supabase, orgId, PHASE16_BRANCH_ENTITY_CODE).catch(
    async () => {
      const created = await createLegalEntity(supabase, {
        organizationId: orgId,
        name: "Phase 16 Branch B",
        entityCode: PHASE16_BRANCH_ENTITY_CODE,
        entityType: "llc",
      });
      return { id: created.id, entity_code: PHASE16_BRANCH_ENTITY_CODE, is_default: false };
    },
  );

  const entityAId = mainEntity.id;
  const entityBId = branchEntity.id;
  if (entityAId === entityBId) {
    throw new Error("Intercompany acceptance requires distinct MAIN and branch entities");
  }
  await ensureCoa(supabase, orgId, entityAId);
  await ensureCoa(supabase, orgId, entityBId);

  const closedA = await booksClosedThrough(supabase, orgId, entityAId);
  const closedB = await booksClosedThrough(supabase, orgId, entityBId);
  const openDate = dayAfter(closedA && closedB ? (closedA > closedB ? closedA : closedB) : closedA ?? closedB ?? "2020-01-01");

  const cashA = await accountByCode(supabase, orgId, entityAId, "1000");
  const cashB = await accountByCode(supabase, orgId, entityBId, "1000");
  const expenseB = await accountByCode(supabase, orgId, entityBId, "6000");

  const hfacJournalsBefore = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG);

  const results: Result[] = [];
  async function run(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      results.push({ name, pass: true });
      console.log(`✓ ${name}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ name, pass: false, detail });
      console.log(`✗ ${name} — ${detail}`);
    }
  }

  await run("16D_01 valid entity pair accepted", async () => {
    const r = await postIntercompanyFundTransfer(supabase, {
      organizationId: orgId,
      sourceLegalEntityId: entityAId,
      counterpartyLegalEntityId: entityBId,
      entryDate: openDate,
      amount: 50,
      description: `${ACCEPT_MEMO} fund transfer 01`,
      sourceCashAccountId: cashA.id,
      counterpartyCashAccountId: cashB.id,
      idempotencyKey: `${ACCEPT_MEMO}-01`,
    });
    if (!r.intercompanyTransactionId) throw new Error("missing group id");
  });

  await run("16D_02 self intercompany rejected", async () => {
    const { error } = await supabase.rpc("teller_atomic_post_intercompany", {
      p_organization_id: orgId,
      p_source_legal_entity_id: entityAId,
      p_counterparty_legal_entity_id: entityAId,
      p_transaction_type: "manual",
      p_entry_date: openDate,
      p_amount: 10,
      p_description: "self",
      p_reference: null,
      p_source_lines: [],
      p_counterparty_lines: [],
      p_idempotency_key: `${ACCEPT_MEMO}-self`,
      p_external_event_id: null,
      p_metadata: {},
      p_actor_id: null,
      p_simulate_failure_after: null,
    });
    if (!error?.message.match(/distinct/i)) throw new Error(`expected distinct error, got ${error?.message}`);
  });

  await run("16D_03 cross-org pair rejected", async () => {
    const { data: foreignEntity } = await supabase
      .from("teller_legal_entities")
      .select("id")
      .eq("organization_id", foreignOrgId)
      .eq("is_default", true)
      .maybeSingle();
    if (!foreignEntity?.id) throw new Error("foreign entity missing");
    const { error } = await supabase.rpc("teller_atomic_post_intercompany", {
      p_organization_id: orgId,
      p_source_legal_entity_id: entityAId,
      p_counterparty_legal_entity_id: foreignEntity.id,
      p_transaction_type: "manual",
      p_entry_date: openDate,
      p_amount: 10,
      p_description: "cross org",
      p_reference: null,
      p_source_lines: [{ account_id: cashA.id, debit: 10, credit: 0, party_id: null, job_id: null, job_cost_category_id: null, cost_classification: "", fixed_asset_id: null, memo: "" }],
      p_counterparty_lines: [{ account_id: cashB.id, debit: 10, credit: 0, party_id: null, job_id: null, job_cost_category_id: null, cost_classification: "", fixed_asset_id: null, memo: "" }],
      p_idempotency_key: `${ACCEPT_MEMO}-cross-org`,
      p_external_event_id: null,
      p_metadata: {},
      p_actor_id: null,
      p_simulate_failure_after: null,
    });
    if (!error?.message.match(/belong to organization|not found/i)) {
      throw new Error(`expected org boundary error, got ${error?.message}`);
    }
  });

  await run("16D_05 expense-on-behalf posts two journals", async () => {
    const r = await postExpenseOnBehalf(supabase, {
      organizationId: orgId,
      sourceLegalEntityId: entityAId,
      counterpartyLegalEntityId: entityBId,
      entryDate: openDate,
      amount: 75,
      description: `${ACCEPT_MEMO} expense on behalf`,
      sourcePaymentAccountId: cashA.id,
      counterpartyExpenseAccountId: expenseB.id,
      idempotencyKey: `${ACCEPT_MEMO}-expense`,
    });
    if (!r.sourceJournalId || !r.counterpartyJournalId) throw new Error("missing journals");
  });

  await run("16D_06 each journal independently balances", async () => {
    const { data: tx } = await supabase
      .from("teller_intercompany_transactions")
      .select("source_journal_id, counterparty_journal_id")
      .eq("organization_id", orgId)
      .eq("idempotency_key", `${ACCEPT_MEMO}-expense`)
      .maybeSingle();
    if (!tx) throw new Error("tx missing");
    for (const entryId of [tx.source_journal_id, tx.counterparty_journal_id]) {
      const { data: lines } = await supabase.from("teller_journal_lines").select("debit, credit").eq("entry_id", entryId);
      const debit = (lines ?? []).reduce((s, l) => s + Number(l.debit), 0);
      const credit = (lines ?? []).reduce((s, l) => s + Number(l.credit), 0);
      if (Math.abs(debit - credit) > 0.01) throw new Error(`unbalanced ${entryId}`);
    }
  });

  await run("16D_07 source journal uses only A accounts", async () => {
    const { data: tx } = await supabase
      .from("teller_intercompany_transactions")
      .select("source_journal_id")
      .eq("idempotency_key", `${ACCEPT_MEMO}-expense`)
      .maybeSingle();
    if (!tx?.source_journal_id) throw new Error("tx missing");
    await assertJournalUsesEntityAccounts(supabase, tx.source_journal_id, entityAId);
  });

  await run("16D_08 counterparty journal uses only B accounts", async () => {
    const { data: tx } = await supabase
      .from("teller_intercompany_transactions")
      .select("counterparty_journal_id")
      .eq("idempotency_key", `${ACCEPT_MEMO}-expense`)
      .maybeSingle();
    if (!tx?.counterparty_journal_id) throw new Error("tx missing");
    await assertJournalUsesEntityAccounts(supabase, tx.counterparty_journal_id, entityBId);
  });

  await run("16D_09 journals linked to one intercompany group", async () => {
    const { data: tx } = await supabase
      .from("teller_intercompany_transactions")
      .select("id, source_journal_id, counterparty_journal_id")
      .eq("idempotency_key", `${ACCEPT_MEMO}-expense`)
      .maybeSingle();
    if (!tx?.source_journal_id || !tx.counterparty_journal_id) throw new Error("journals not linked");
    const { data: entries } = await supabase
      .from("teller_journal_entries")
      .select("source_id")
      .in("id", [tx.source_journal_id, tx.counterparty_journal_id]);
    if (entries?.some((e) => e.source_id !== tx.id)) throw new Error("journal source_id mismatch");
  });

  await run("16D_10 duplicate idempotency creates no duplicate journals", async () => {
    const before = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("source_kind", "intercompany");
    await postExpenseOnBehalf(supabase, {
      organizationId: orgId,
      sourceLegalEntityId: entityAId,
      counterpartyLegalEntityId: entityBId,
      entryDate: openDate,
      amount: 75,
      description: `${ACCEPT_MEMO} expense on behalf dup`,
      sourcePaymentAccountId: cashA.id,
      counterpartyExpenseAccountId: expenseB.id,
      idempotencyKey: `${ACCEPT_MEMO}-expense`,
    });
    const after = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("source_kind", "intercompany");
    if ((after.count ?? 0) !== (before.count ?? 0)) throw new Error("duplicate journals created");
  });

  await run("16D_12 atomic failure leaves zero posted sides", async () => {
    const before = await supabase
      .from("teller_intercompany_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("idempotency_key", `${ACCEPT_MEMO}-atomic-fail`);
    const { error } = await supabase.rpc("teller_atomic_post_intercompany", {
      p_organization_id: orgId,
      p_source_legal_entity_id: entityAId,
      p_counterparty_legal_entity_id: entityBId,
      p_transaction_type: "fund_transfer",
      p_entry_date: openDate,
      p_amount: 25,
      p_description: `${ACCEPT_MEMO} atomic fail`,
      p_reference: null,
      p_source_lines: [
        { account_id: cashA.id, debit: 0, credit: 25, party_id: null, job_id: null, job_cost_category_id: null, cost_classification: "", fixed_asset_id: null, memo: "" },
        { account_id: cashA.id, debit: 25, credit: 0, party_id: null, job_id: null, job_cost_category_id: null, cost_classification: "", fixed_asset_id: null, memo: "" },
      ],
      p_counterparty_lines: [
        { account_id: cashB.id, debit: 25, credit: 0, party_id: null, job_id: null, job_cost_category_id: null, cost_classification: "", fixed_asset_id: null, memo: "" },
        { account_id: cashB.id, debit: 0, credit: 25, party_id: null, job_id: null, job_cost_category_id: null, cost_classification: "", fixed_asset_id: null, memo: "" },
      ],
      p_idempotency_key: `${ACCEPT_MEMO}-atomic-fail`,
      p_external_event_id: null,
      p_metadata: {},
      p_actor_id: null,
      p_simulate_failure_after: "after_source_journal",
    });
    if (!error) throw new Error("expected simulated failure");
    const after = await supabase
      .from("teller_intercompany_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("idempotency_key", `${ACCEPT_MEMO}-atomic-fail`);
    if ((after.count ?? 0) !== (before.count ?? 0)) throw new Error("orphan intercompany row after failure");
  });

  await run("16D_13 fund transfer due-from/due-to pattern", async () => {
    const r = await postIntercompanyFundTransfer(supabase, {
      organizationId: orgId,
      sourceLegalEntityId: entityAId,
      counterpartyLegalEntityId: entityBId,
      entryDate: openDate,
      amount: 100,
      description: `${ACCEPT_MEMO} fund transfer 13`,
      sourceCashAccountId: cashA.id,
      counterpartyCashAccountId: cashB.id,
      idempotencyKey: `${ACCEPT_MEMO}-13`,
    });
    if (!r.sourceJournalId) throw new Error("missing journal");
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("account_id")
      .eq("entry_id", r.sourceJournalId);
    const accountIds = (lines ?? []).map((line) => line.account_id as string);
    const { data: accounts } = await supabase
      .from("teller_accounts")
      .select("subtype")
      .in("id", accountIds);
    const subtypes = (accounts ?? []).map((account) => account.subtype as string);
    if (!subtypes.includes("due_from")) throw new Error("due_from missing on source side");
  });

  await run("16D_15 reversal creates two balanced reversal journals", async () => {
    const { data: tx } = await supabase
      .from("teller_intercompany_transactions")
      .select("id")
      .eq("idempotency_key", `${ACCEPT_MEMO}-13`)
      .maybeSingle();
    const r = await reverseIntercompanyTransaction(supabase, {
      organizationId: orgId,
      intercompanyTransactionId: tx!.id,
      reversalDate: openDate,
      memo: `${ACCEPT_MEMO} reversal`,
    });
    if (!r.sourceReversalJournalId || !r.counterpartyReversalJournalId) throw new Error("missing reversal journals");
  });

  await run("16D_16 reversal does not delete original", async () => {
    const { data: tx } = await supabase
      .from("teller_intercompany_transactions")
      .select("id, status, source_journal_id")
      .eq("idempotency_key", `${ACCEPT_MEMO}-13`)
      .maybeSingle();
    if (tx?.status !== "reversed") throw new Error("original not marked reversed");
    const { data: entry } = await supabase.from("teller_journal_entries").select("id").eq("id", tx.source_journal_id!).maybeSingle();
    if (!entry?.id) throw new Error("original journal deleted");
  });

  await run("16D_17 pair reconciliation difference zero", async () => {
    const balance = await getIntercompanyPairBalance(supabase, {
      organizationId: orgId,
      entityAId,
      entityBId,
      asOf: openDate,
    });
    if (!balance.balanced) {
      throw new Error(`not balanced: ${balance.receivablePayableDifference}`);
    }
  });

  await run("16D_20 no consolidated elimination created", async () => {
    const { error } = await supabase.from("teller_consolidation_groups").select("id").limit(1);
    if (!error?.message.match(/does not exist|schema cache/i)) {
      throw new Error("consolidation groups must not exist in 16D");
    }
  });

  await run("16D_21 no HFAC mutation", async () => {
    const after = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG);
    if ((after.count ?? 0) !== (hfacJournalsBefore.count ?? 0)) throw new Error("HFAC journals changed");
  });

  await run("16D_22 no unbalanced journal in demo org", async () => {
    const { data: entries } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .eq("organization_id", orgId);
    for (const entry of entries ?? []) {
      const { data: lines } = await supabase.from("teller_journal_lines").select("debit, credit").eq("entry_id", entry.id);
      const debit = (lines ?? []).reduce((s, l) => s + Number(l.debit), 0);
      const credit = (lines ?? []).reduce((s, l) => s + Number(l.credit), 0);
      if (Math.abs(debit - credit) > 0.01) throw new Error(`unbalanced ${entry.id}`);
    }
  });

  await run("16D_11 closed counterparty period rejects entire transaction", async () => {
    let closedThroughB = await booksClosedThrough(supabase, orgId, entityBId);
    let blockedDate = closedThroughB;
    if (!blockedDate) {
      blockedDate = nextCloseablePeriodEnd(closedThroughB);
      const { error: closeError } = await supabase.rpc("teller_close_accounting_period", {
        p_organization_id: orgId,
        p_legal_entity_id: entityBId,
        p_period_end: blockedDate,
        p_notes: `${ACCEPT_MEMO} close B for dual-period test`,
      });
      if (closeError) throw new Error(closeError.message);
      closedThroughB = blockedDate;
    }
    try {
      await postIntercompanyFundTransfer(supabase, {
        organizationId: orgId,
        sourceLegalEntityId: entityAId,
        counterpartyLegalEntityId: entityBId,
        entryDate: blockedDate,
        amount: 15,
        description: `${ACCEPT_MEMO} blocked by closed B`,
        sourceCashAccountId: cashA.id,
        counterpartyCashAccountId: cashB.id,
        idempotencyKey: `${ACCEPT_MEMO}-closed-b`,
      });
      throw new Error("expected closed period rejection");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/Counterparty entity accounting period is closed|period is closed/i.test(message)) {
        throw err;
      }
    }
  });

  await run("16D_24 posted intercompany group immutable", async () => {
    const { data: tx } = await supabase
      .from("teller_intercompany_transactions")
      .select("id, amount")
      .eq("idempotency_key", `${ACCEPT_MEMO}-expense`)
      .maybeSingle();
    const { error } = await supabase
      .from("teller_intercompany_transactions")
      .update({ amount: Number(tx!.amount) + 1 })
      .eq("id", tx!.id);
    if (!error?.message.match(/cannot be modified/i)) throw new Error(`expected immutability error, got ${error?.message}`);
  });

  const passed = results.filter((r) => r.pass).length;
  console.log(`\nPhase 16D acceptance: ${passed}/${results.length}`);
  if (passed !== results.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
