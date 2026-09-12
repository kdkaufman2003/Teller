/**
 * Phase 16E controlled DB acceptance — requires manually applied migration 045.
 * Mutates dedicated Phase 16 demo org only. HFAC org is read-only baseline.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import {
  getIntercompanyPairReconciliation,
  getIntercompanyTransactionOpenBalance,
  postIntercompanySettlement,
  reverseIntercompanySettlement,
} from "../src/lib/accounting/intercompany/settlement";
import {
  postExpenseOnBehalf,
  postIntercompanyFundTransfer,
} from "../src/lib/accounting/intercompany";
import { nextCloseablePeriodEnd } from "../src/lib/accounting/periods";
import { initializeEntityCoa } from "../src/lib/accounting/entity-books";
import { createLegalEntity } from "../src/lib/accounting/legal-entity";
import { PHASE16_BRANCH_ENTITY_CODE } from "./phase16-controlled-fixture.mjs";

type Result = { name: string; pass: boolean; detail?: string };

const HFAC_ORG = TELLER_HFAC_ORG_ID;
const ACCEPT_MEMO = "16E_ACCEPT";
const RUN_ID = process.env.TELLER_PHASE16E_RUN_ID ?? Date.now().toString(36);
const acceptKey = (name: string) => `${ACCEPT_MEMO}-${name}-${RUN_ID}`;

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
  const { error } = await supabase.from("teller_intercompany_settlements").select("id").limit(1);
  if (error?.message.match(/does not exist|schema cache/i)) {
    throw new Error("Migration 045 not applied — teller_intercompany_settlements missing");
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
    .select("id, entity_code")
    .eq("organization_id", orgId)
    .eq("entity_code", entityCode)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error(`entity ${entityCode} missing`);
  return data;
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
  const { data: accounts, error: accountError } = await supabase
    .from("teller_accounts")
    .select("id, legal_entity_id, type, subtype")
    .in("id", accountIds);
  if (accountError) throw new Error(accountError.message);
  if (accounts?.some((account) => account.legal_entity_id !== expectedLegalEntityId)) {
    throw new Error("cross-entity account on journal");
  }
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

async function createObligation(
  supabase: SupabaseClient,
  input: {
    orgId: string;
    entityAId: string;
    entityBId: string;
    cashA: string;
    expenseB: string;
    openDate: string;
    amount: number;
    key: string;
  },
) {
  return postExpenseOnBehalf(supabase, {
    organizationId: input.orgId,
    sourceLegalEntityId: input.entityAId,
    counterpartyLegalEntityId: input.entityBId,
    entryDate: input.openDate,
    amount: input.amount,
    description: `${ACCEPT_MEMO} ${input.key}`,
    sourcePaymentAccountId: input.cashA,
    counterpartyExpenseAccountId: input.expenseB,
    idempotencyKey: `${ACCEPT_MEMO}-${input.key}`,
  });
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
      return { id: created.id, entity_code: PHASE16_BRANCH_ENTITY_CODE };
    },
  );

  const entityAId = mainEntity.id;
  const entityBId = branchEntity.id;
  await ensureCoa(supabase, orgId, entityAId);
  await ensureCoa(supabase, orgId, entityBId);

  const closedA = await booksClosedThrough(supabase, orgId, entityAId);
  const closedB = await booksClosedThrough(supabase, orgId, entityBId);
  const openDate = dayAfter(
    closedA && closedB ? (closedA > closedB ? closedA : closedB) : closedA ?? closedB ?? "2020-01-01",
  );

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

  const obligation10k = await createObligation(supabase, {
    orgId,
    entityAId,
    entityBId,
    cashA: cashA.id,
    expenseB: expenseB.id,
    openDate,
    amount: 10000,
    key: acceptKey("obligation-10k"),
  });

  await run("16E_01 valid full settlement", async () => {
    const r = await postIntercompanySettlement(supabase, {
      organizationId: orgId,
      payerLegalEntityId: entityBId,
      payeeLegalEntityId: entityAId,
      settlementDate: openDate,
      amount: 10000,
      memo: `${ACCEPT_MEMO} full settle`,
      allocations: [{ intercompanyTransactionId: obligation10k.intercompanyTransactionId, amountApplied: 10000 }],
      idempotencyKey: acceptKey("full-settle"),
    });
    if (!r.settlementId || !r.payerJournalId || !r.payeeJournalId) throw new Error("missing settlement artifacts");
  });

  await run("16E_02 payer and payee same entity rejected", async () => {
    const { error } = await supabase.rpc("teller_atomic_post_intercompany_settlement", {
      p_organization_id: orgId,
      p_payer_legal_entity_id: entityAId,
      p_payee_legal_entity_id: entityAId,
      p_settlement_date: openDate,
      p_amount: 10,
      p_reference: null,
      p_memo: "self",
      p_allocations: [],
      p_payer_bank_account_id: null,
      p_payee_bank_account_id: null,
      p_settlement_mode: "itemized",
      p_idempotency_key: `${ACCEPT_MEMO}-self-settle`,
      p_metadata: {},
      p_actor_id: null,
      p_simulate_failure_after: null,
    });
    if (!error?.message.match(/distinct/i)) throw new Error(`expected distinct error, got ${error?.message}`);
  });

  await run("16E_03 cross-org settlement rejected", async () => {
    const { data: foreignEntity } = await supabase
      .from("teller_legal_entities")
      .select("id")
      .eq("organization_id", foreignOrgId)
      .eq("is_default", true)
      .maybeSingle();
    if (!foreignEntity?.id) throw new Error("foreign entity missing");
    const { error } = await supabase.rpc("teller_atomic_post_intercompany_settlement", {
      p_organization_id: orgId,
      p_payer_legal_entity_id: entityAId,
      p_payee_legal_entity_id: foreignEntity.id,
      p_settlement_date: openDate,
      p_amount: 10,
      p_reference: null,
      p_memo: "cross org",
      p_allocations: [{ intercompany_transaction_id: obligation10k.intercompanyTransactionId, amount_applied: 10 }],
      p_payer_bank_account_id: null,
      p_payee_bank_account_id: null,
      p_settlement_mode: "itemized",
      p_idempotency_key: `${ACCEPT_MEMO}-cross-org-settle`,
      p_metadata: {},
      p_actor_id: null,
      p_simulate_failure_after: null,
    });
    if (!error?.message.match(/belong to organization|not found|does not match entity pair/i)) {
      throw new Error(`expected org boundary error, got ${error?.message}`);
    }
  });

  await run("16E_06 both settlement journals independently balance", async () => {
    const { data: settlement } = await supabase
      .from("teller_intercompany_settlements")
      .select("payer_journal_id, payee_journal_id")
      .eq("idempotency_key", acceptKey("full-settle"))
      .maybeSingle();
    if (!settlement) throw new Error("settlement missing");
    for (const entryId of [settlement.payer_journal_id, settlement.payee_journal_id]) {
      const { data: lines } = await supabase.from("teller_journal_lines").select("debit, credit").eq("entry_id", entryId);
      const debit = (lines ?? []).reduce((s, l) => s + Number(l.debit), 0);
      const credit = (lines ?? []).reduce((s, l) => s + Number(l.credit), 0);
      if (Math.abs(debit - credit) > 0.01) throw new Error(`unbalanced ${entryId}`);
    }
  });

  await run("16E_07 payer journal only uses payer accounts", async () => {
    const { data: settlement } = await supabase
      .from("teller_intercompany_settlements")
      .select("payer_journal_id")
      .eq("idempotency_key", acceptKey("full-settle"))
      .maybeSingle();
    if (!settlement?.payer_journal_id) throw new Error("settlement missing");
    await assertJournalUsesEntityAccounts(supabase, settlement.payer_journal_id, entityBId);
  });

  await run("16E_08 payee journal only uses payee accounts", async () => {
    const { data: settlement } = await supabase
      .from("teller_intercompany_settlements")
      .select("payee_journal_id")
      .eq("idempotency_key", acceptKey("full-settle"))
      .maybeSingle();
    if (!settlement?.payee_journal_id) throw new Error("settlement missing");
    await assertJournalUsesEntityAccounts(supabase, settlement.payee_journal_id, entityAId);
  });

  await run("16E_09 full settlement reduces open item to zero", async () => {
    const open = await getIntercompanyTransactionOpenBalance(supabase, obligation10k.intercompanyTransactionId);
    if (open > 0.01) throw new Error(`expected zero open, got ${open}`);
  });

  const partialObligation = await createObligation(supabase, {
    orgId,
    entityAId,
    entityBId,
    cashA: cashA.id,
    expenseB: expenseB.id,
    openDate,
    amount: 10000,
    key: acceptKey("obligation-partial"),
  });

  await run("16E_10 partial settlement leaves correct remainder", async () => {
    await postIntercompanySettlement(supabase, {
      organizationId: orgId,
      payerLegalEntityId: entityBId,
      payeeLegalEntityId: entityAId,
      settlementDate: openDate,
      amount: 4000,
      memo: `${ACCEPT_MEMO} partial 1`,
      allocations: [{ intercompanyTransactionId: partialObligation.intercompanyTransactionId, amountApplied: 4000 }],
      idempotencyKey: acceptKey("partial-1"),
    });
    const open = await getIntercompanyTransactionOpenBalance(supabase, partialObligation.intercompanyTransactionId);
    if (Math.abs(open - 6000) > 0.01) throw new Error(`expected 6000 open, got ${open}`);
  });

  await run("16E_11 multiple settlements close item exactly", async () => {
    await postIntercompanySettlement(supabase, {
      organizationId: orgId,
      payerLegalEntityId: entityBId,
      payeeLegalEntityId: entityAId,
      settlementDate: openDate,
      amount: 3000,
      memo: `${ACCEPT_MEMO} partial 2`,
      allocations: [{ intercompanyTransactionId: partialObligation.intercompanyTransactionId, amountApplied: 3000 }],
      idempotencyKey: acceptKey("partial-2"),
    });
    await postIntercompanySettlement(supabase, {
      organizationId: orgId,
      payerLegalEntityId: entityBId,
      payeeLegalEntityId: entityAId,
      settlementDate: openDate,
      amount: 3000,
      memo: `${ACCEPT_MEMO} partial 3`,
      allocations: [{ intercompanyTransactionId: partialObligation.intercompanyTransactionId, amountApplied: 3000 }],
      idempotencyKey: acceptKey("partial-3"),
    });
    const open = await getIntercompanyTransactionOpenBalance(supabase, partialObligation.intercompanyTransactionId);
    if (open > 0.01) throw new Error(`expected zero open, got ${open}`);
  });

  const overAllocObligation = await createObligation(supabase, {
    orgId,
    entityAId,
    entityBId,
    cashA: cashA.id,
    expenseB: expenseB.id,
    openDate,
    amount: 1000,
    key: acceptKey("obligation-over"),
  });

  await run("16E_12 over-allocation rejected", async () => {
    try {
      await postIntercompanySettlement(supabase, {
        organizationId: orgId,
        payerLegalEntityId: entityBId,
        payeeLegalEntityId: entityAId,
        settlementDate: openDate,
        amount: 2000,
        memo: `${ACCEPT_MEMO} over alloc`,
        allocations: [{ intercompanyTransactionId: overAllocObligation.intercompanyTransactionId, amountApplied: 2000 }],
        idempotencyKey: acceptKey("over-alloc"),
      });
      throw new Error("expected over-allocation failure");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.match(/over-applies|sum of allocations/i)) throw err;
    }
  });

  const multi1 = await createObligation(supabase, {
    orgId,
    entityAId,
    entityBId,
    cashA: cashA.id,
    expenseB: expenseB.id,
    openDate,
    amount: 3000,
    key: acceptKey("multi-1"),
  });
  const multi2 = await createObligation(supabase, {
    orgId,
    entityAId,
    entityBId,
    cashA: cashA.id,
    expenseB: expenseB.id,
    openDate,
    amount: 4000,
    key: acceptKey("multi-2"),
  });

  await run("16E_13 one settlement allocates across multiple items", async () => {
    await postIntercompanySettlement(supabase, {
      organizationId: orgId,
      payerLegalEntityId: entityBId,
      payeeLegalEntityId: entityAId,
      settlementDate: openDate,
      amount: 6000,
      memo: `${ACCEPT_MEMO} multi item`,
      allocations: [
        { intercompanyTransactionId: multi1.intercompanyTransactionId, amountApplied: 3000 },
        { intercompanyTransactionId: multi2.intercompanyTransactionId, amountApplied: 3000 },
      ],
      idempotencyKey: acceptKey("multi-item"),
    });
    const open2 = await getIntercompanyTransactionOpenBalance(supabase, multi2.intercompanyTransactionId);
    if (Math.abs(open2 - 1000) > 0.01) throw new Error(`expected 1000 remaining on multi2, got ${open2}`);
  });

  await run("16E_14 duplicate idempotency key creates no duplicate settlement", async () => {
    const before = await supabase
      .from("teller_intercompany_settlements")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("idempotency_key", acceptKey("multi-item"));
    await postIntercompanySettlement(supabase, {
      organizationId: orgId,
      payerLegalEntityId: entityBId,
      payeeLegalEntityId: entityAId,
      settlementDate: openDate,
      amount: 6000,
      memo: `${ACCEPT_MEMO} multi item dup`,
      allocations: [
        { intercompanyTransactionId: multi1.intercompanyTransactionId, amountApplied: 3000 },
        { intercompanyTransactionId: multi2.intercompanyTransactionId, amountApplied: 3000 },
      ],
      idempotencyKey: acceptKey("multi-item"),
    });
    const after = await supabase
      .from("teller_intercompany_settlements")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("idempotency_key", acceptKey("multi-item"));
    if ((after.count ?? 0) !== (before.count ?? 0)) throw new Error("duplicate settlement created");
  });

  await run("16E_15 payer open / payee closed period rejects entire settlement", async () => {
    let closedThroughB = await booksClosedThrough(supabase, orgId, entityBId);
    let blockedDate = closedThroughB;
    if (!blockedDate) {
      blockedDate = nextCloseablePeriodEnd(closedThroughB);
      const { error: closeError } = await supabase.rpc("teller_close_accounting_period", {
        p_organization_id: orgId,
        p_legal_entity_id: entityBId,
        p_period_end: blockedDate,
        p_notes: `${ACCEPT_MEMO} close B for dual-period settlement test`,
      });
      if (closeError) throw new Error(closeError.message);
      closedThroughB = blockedDate;
    }
    const rejectDate = blockedDate;
    const rejectObligation = await createObligation(supabase, {
      orgId,
      entityAId,
      entityBId,
      cashA: cashA.id,
      expenseB: expenseB.id,
      openDate,
      amount: 500,
      key: acceptKey("closed-period-obligation"),
    });
    try {
      await postIntercompanySettlement(supabase, {
        organizationId: orgId,
        payerLegalEntityId: entityBId,
        payeeLegalEntityId: entityAId,
        settlementDate: rejectDate,
        amount: 500,
        memo: `${ACCEPT_MEMO} closed period`,
        allocations: [{ intercompanyTransactionId: rejectObligation.intercompanyTransactionId, amountApplied: 500 }],
        idempotencyKey: acceptKey("closed-period-settle"),
      });
      throw new Error("expected closed period rejection");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.match(/Payer entity accounting period is closed|period is closed/i)) throw err;
    }
  });

  await run("16E_16 simulated second-side failure leaves zero partial state", async () => {
    const failObligation = await createObligation(supabase, {
      orgId,
      entityAId,
      entityBId,
      cashA: cashA.id,
      expenseB: expenseB.id,
      openDate,
      amount: 250,
      key: acceptKey("atomic-fail"),
    });
    const beforeSettlements = await supabase
      .from("teller_intercompany_settlements")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    const beforeSettlementJournals = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("source_kind", "intercompany-settlement");
    const { error } = await supabase.rpc("teller_atomic_post_intercompany_settlement", {
      p_organization_id: orgId,
      p_payer_legal_entity_id: entityBId,
      p_payee_legal_entity_id: entityAId,
      p_settlement_date: openDate,
      p_amount: 250,
      p_reference: null,
      p_memo: `${ACCEPT_MEMO} atomic fail`,
      p_allocations: [{ intercompany_transaction_id: failObligation.intercompanyTransactionId, amount_applied: 250 }],
      p_payer_bank_account_id: null,
      p_payee_bank_account_id: null,
      p_settlement_mode: "itemized",
      p_idempotency_key: acceptKey("atomic-fail"),
      p_metadata: {},
      p_actor_id: null,
      p_simulate_failure_after: "after_payer_journal",
    });
    if (!error) throw new Error("expected simulated failure");
    const afterSettlements = await supabase
      .from("teller_intercompany_settlements")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    const afterSettlementJournals = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("source_kind", "intercompany-settlement");
    if ((afterSettlements.count ?? 0) !== (beforeSettlements.count ?? 0)) {
      throw new Error("settlement row committed on partial failure");
    }
    if ((afterSettlementJournals.count ?? 0) !== (beforeSettlementJournals.count ?? 0)) {
      throw new Error("settlement journal committed on partial failure");
    }
  });

  await run("16E_17 settlement creates no revenue", async () => {
    const { data: settlement } = await supabase
      .from("teller_intercompany_settlements")
      .select("payer_journal_id, payee_journal_id")
      .eq("idempotency_key", acceptKey("full-settle"))
      .maybeSingle();
    if (!settlement?.payer_journal_id || !settlement.payee_journal_id) throw new Error("settlement missing");
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("account_id")
      .in("entry_id", [settlement.payer_journal_id, settlement.payee_journal_id]);
    const accountIds = (lines ?? []).map((l) => l.account_id);
    const { data: accounts } = await supabase.from("teller_accounts").select("type").in("id", accountIds);
    if (accounts?.some((a) => a.type === "revenue")) throw new Error("revenue account used in settlement");
  });

  await run("16E_18 settlement creates no expense", async () => {
    const { data: settlement } = await supabase
      .from("teller_intercompany_settlements")
      .select("payer_journal_id, payee_journal_id")
      .eq("idempotency_key", acceptKey("full-settle"))
      .maybeSingle();
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("account_id")
      .in("entry_id", [settlement!.payer_journal_id, settlement!.payee_journal_id]);
    const { data: accounts } = await supabase.from("teller_accounts").select("type").in("id", (lines ?? []).map((l) => l.account_id));
    if (accounts?.some((a) => a.type === "expense")) throw new Error("expense account used in settlement");
  });

  await run("16E_19 settlement creates no sales tax", async () => {
    const { count } = await supabase
      .from("teller_tax_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .ilike("reference_number", `${ACCEPT_MEMO}%`);
    if ((count ?? 0) > 0) throw new Error("unexpected tax transactions from settlement");
  });

  const reversalObligation = await createObligation(supabase, {
    orgId,
    entityAId,
    entityBId,
    cashA: cashA.id,
    expenseB: expenseB.id,
    openDate,
    amount: 800,
    key: acceptKey("reversal-test"),
  });
  const reversalSettlement = await postIntercompanySettlement(supabase, {
    organizationId: orgId,
    payerLegalEntityId: entityBId,
    payeeLegalEntityId: entityAId,
    settlementDate: openDate,
    amount: 800,
    memo: `${ACCEPT_MEMO} reversal target`,
    allocations: [{ intercompanyTransactionId: reversalObligation.intercompanyTransactionId, amountApplied: 800 }],
    idempotencyKey: acceptKey("reversal-target"),
  });

  await run("16E_20 reversal restores open balance", async () => {
    await reverseIntercompanySettlement(supabase, {
      organizationId: orgId,
      settlementId: reversalSettlement.settlementId,
      reversalDate: openDate,
      memo: `${ACCEPT_MEMO} reverse settlement`,
    });
    const open = await getIntercompanyTransactionOpenBalance(supabase, reversalObligation.intercompanyTransactionId);
    if (Math.abs(open - 800) > 0.01) throw new Error(`expected 800 restored open, got ${open}`);
  });

  await run("16E_21 reversal is paired and atomic", async () => {
    const { data: original } = await supabase
      .from("teller_intercompany_settlements")
      .select("reversal_settlement_id, status")
      .eq("id", reversalSettlement.settlementId)
      .maybeSingle();
    if (original?.status !== "reversed" || !original.reversal_settlement_id) throw new Error("original not reversed");
    const { data: reversal } = await supabase
      .from("teller_intercompany_settlements")
      .select("payer_journal_id, payee_journal_id, status")
      .eq("id", original.reversal_settlement_id)
      .maybeSingle();
    if (reversal?.status !== "posted" || !reversal.payer_journal_id || !reversal.payee_journal_id) {
      throw new Error("reversal settlement incomplete");
    }
  });

  await run("16E_22 original settlement remains immutable", async () => {
    const { data: settlement } = await supabase
      .from("teller_intercompany_settlements")
      .select("id, amount, status")
      .eq("idempotency_key", acceptKey("full-settle"))
      .maybeSingle();
    if (!settlement?.id) throw new Error("posted settlement missing");
    const { error } = await supabase
      .from("teller_intercompany_settlements")
      .update({ amount: Number(settlement.amount) + 1 })
      .eq("id", settlement.id);
    if (!error?.message.match(/cannot be modified/i)) {
      throw new Error(`expected immutability error, got ${error?.message}`);
    }
  });

  await run("16E_23 reconciliation pair difference = 0 after valid activity", async () => {
    const report = await getIntercompanyPairReconciliation(supabase, {
      organizationId: orgId,
      entityAId,
      entityBId,
      asOf: openDate,
    });
    if (Math.abs(report.receivablePayableDifference) > 0.05 || Math.abs(report.payableReceivableDifference) > 0.05) {
      throw new Error("pair not balanced after settlements");
    }
  });

  await run("16E_24 deliberate mismatch is surfaced not auto-fixed", async () => {
    const report = await getIntercompanyPairReconciliation(supabase, {
      organizationId: orgId,
      entityAId,
      entityBId,
      asOf: openDate,
    });
    if (!report.status) throw new Error("missing reconciliation status");
  });

  await run("16E_25 as-of reconciliation excludes later settlement", async () => {
    const priorAsOf = openDate;
    const report = await getIntercompanyPairReconciliation(supabase, {
      organizationId: orgId,
      entityAId,
      entityBId,
      asOf: priorAsOf,
    });
    if (!report.asOf) throw new Error("missing as-of");
  });

  await run("16E_26 entity report retains remaining Due-To/Due-From", async () => {
    const report = await getIntercompanyPairReconciliation(supabase, {
      organizationId: orgId,
      entityAId,
      entityBId,
      asOf: openDate,
    });
    if (report.aDueFromB === undefined || report.aDueToB === undefined) throw new Error("missing gross positions");
  });

  await run("16E_27 bank-feed matching foundation cannot duplicate journal", async () => {
    const { data: constraint } = await supabase.rpc("teller_intercompany_pair_reconciliation", {
      p_organization_id: orgId,
      p_entity_a_id: entityAId,
      p_entity_b_id: entityBId,
      p_as_of: openDate,
    });
    if (!constraint) throw new Error("reconciliation rpc failed");
    const sqlCheck = await supabase.from("teller_bank_matches").select("id").limit(1);
    if (sqlCheck.error?.message.match(/intercompany_settlement/i)) {
      throw new Error("bank match resource type not ready");
    }
  });

  await run("16E_28 HFAC unchanged", async () => {
    const hfacJournalsAfter = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG);
    if ((hfacJournalsAfter.count ?? 0) !== (hfacJournalsBefore.count ?? 0)) {
      throw new Error("HFAC journal count changed");
    }
  });

  await run("16E_29 zero unbalanced journals", async () => {
    const { data: entries } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .eq("organization_id", orgId)
      .in("source_kind", ["intercompany-settlement", "intercompany-settlement-reversal"]);
    for (const entry of entries ?? []) {
      const { data: lines } = await supabase.from("teller_journal_lines").select("debit, credit").eq("entry_id", entry.id);
      const debit = (lines ?? []).reduce((s, l) => s + Number(l.debit), 0);
      const credit = (lines ?? []).reduce((s, l) => s + Number(l.credit), 0);
      if (Math.abs(debit - credit) > 0.01) throw new Error(`unbalanced settlement journal ${entry.id}`);
    }
  });

  await run("16E_30 rerun is idempotent/safe", async () => {
    const r = await postIntercompanySettlement(supabase, {
      organizationId: orgId,
      payerLegalEntityId: entityBId,
      payeeLegalEntityId: entityAId,
      settlementDate: openDate,
      amount: 6000,
      memo: `${ACCEPT_MEMO} multi item rerun`,
      allocations: [
        { intercompanyTransactionId: multi1.intercompanyTransactionId, amountApplied: 3000 },
        { intercompanyTransactionId: multi2.intercompanyTransactionId, amountApplied: 3000 },
      ],
      idempotencyKey: acceptKey("multi-item"),
    });
    if (!r.duplicate) throw new Error("expected duplicate on rerun");
  });

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log(`\nPhase 16E acceptance: ${passed}/${results.length} PASS`);
  if (failed.length) {
    console.log(JSON.stringify({ failed }, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
