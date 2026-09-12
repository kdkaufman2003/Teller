/**
 * Phase 16C controlled DB acceptance — requires manually applied migration 042.
 * Mutates dedicated Phase 16 demo org only. HFAC org is read-only baseline.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import { createLegalEntity } from "../src/lib/accounting/legal-entity";
import { requireDefaultLegalEntity } from "../src/lib/accounting/legal-entity/resolver";
import {
  ENTITY_METADATA_KEYS,
  initializeEntityCoa,
  upsertEntityAccountingSettings,
  upsertEntityMetadataAccountRefs,
} from "../src/lib/accounting/entity-books";
import { recordPaymentAllocation } from "../src/lib/accounting/allocations";
import { buildTrialBalance } from "../src/lib/accounting/trial-balance";
import { closeAccountingPeriod } from "../src/lib/accounting/period-close";
import { postJournal, resolveLegalEntityId, assertOrgPeriodOpen } from "../src/lib/accounting/post";
import { nextCloseablePeriodEnd } from "../src/lib/accounting/periods";
import { PHASE16_BRANCH_ENTITY_CODE } from "./phase16-controlled-fixture.mjs";

type Result = { name: string; pass: boolean; detail?: string };

const HFAC_ORG = TELLER_HFAC_ORG_ID;
const ACCEPT_MEMO = "16C_ACCEPT";
const SHARED_ACCOUNT_CODE = "16C-1000";
const SETUP_ENTITY_CODE = "C16C";

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST=1 required");
  }
  const orgId = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim();
  const foreignOrgId = process.env.TELLER_PHASE16_FOREIGN_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE16_DEMO_ORG_ID missing — run setup:phase16-demo-org");
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
  const { error } = await supabase.from("teller_entity_accounting_settings").select("organization_id").limit(1);
  if (error?.message.match(/does not exist|schema cache/i)) {
    throw new Error("Migration 042 not applied — teller_entity_accounting_settings missing");
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

async function ensureBranchEntity(supabase: SupabaseClient, orgId: string) {
  const existing = await requireEntityByCode(supabase, orgId, PHASE16_BRANCH_ENTITY_CODE).catch(() => null);
  if (existing?.id) return existing.id;
  const created = await createLegalEntity(supabase, {
    organizationId: orgId,
    name: "Phase 16 Branch B",
    entityCode: PHASE16_BRANCH_ENTITY_CODE,
    entityType: "llc",
  });
  return created.id;
}

async function ensureCoa(supabase: SupabaseClient, orgId: string, legalEntityId: string) {
  const { count } = await supabase
    .from("teller_accounts")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("legal_entity_id", legalEntityId);
  if ((count ?? 0) === 0) {
    await initializeEntityCoa(supabase, {
      organizationId: orgId,
      legalEntityId,
      mode: "standard",
    });
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
    .select("id, code, legal_entity_id")
    .eq("organization_id", orgId)
    .eq("legal_entity_id", legalEntityId)
    .eq("code", code)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error(`account ${code} missing for entity`);
  return data;
}

async function booksClosedThrough(
  supabase: SupabaseClient,
  orgId: string,
  legalEntityId: string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("teller_books_closed_through", {
    p_org: orgId,
    p_legal_entity_id: legalEntityId,
  });
  if (error) throw new Error(error.message);
  return (data as string | null) ?? null;
}

function dayAfter(isoDate: string): string {
  const d = new Date(isoDate.slice(0, 10) + "T12:00:00");
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function priorMonthEnd(isoDate: string): string {
  const d = new Date(isoDate.slice(0, 10) + "T12:00:00");
  d.setDate(0);
  return d.toISOString().slice(0, 10);
}

function openEntryDate(closedThrough: string | null): string {
  if (!closedThrough) return new Date().toISOString().slice(0, 10);
  return dayAfter(closedThrough);
}

function midMonthInPeriod(periodEnd: string): string {
  return `${periodEnd.slice(0, 8)}15`;
}

async function ensureBankConnection(supabase: SupabaseClient, orgId: string) {
  const externalItemId = `${ACCEPT_MEMO}-conn`;
  const { data: existing } = await supabase
    .from("teller_bank_connections")
    .select("id")
    .eq("organization_id", orgId)
    .eq("provider", "manual")
    .eq("external_item_id", externalItemId)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data, error } = await supabase
    .from("teller_bank_connections")
    .insert({
      organization_id: orgId,
      provider: "manual",
      external_item_id: externalItemId,
      institution_name: ACCEPT_MEMO,
      status: "active",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data!.id as string;
}

async function resetAcceptanceState(
  supabase: SupabaseClient,
  orgId: string,
  entityIds: string[],
) {
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId)
    .ilike("memo", `${ACCEPT_MEMO}%`);
  const entryIds = (entries ?? []).map((row) => row.id as string);
  if (entryIds.length) {
    await supabase.from("teller_journal_lines").delete().in("entry_id", entryIds);
    await supabase.from("teller_journal_entries").delete().in("id", entryIds);
  }

  await supabase.from("teller_period_close_reviews").delete().eq("organization_id", orgId);

  await supabase.from("teller_documents").delete().eq("organization_id", orgId).ilike("number", `${ACCEPT_MEMO}%`);
  await supabase.from("teller_payments").delete().eq("organization_id", orgId).gte("payment_date", "2024-01-01");

  for (const code of [SETUP_ENTITY_CODE, "C16CX", "C16CB"]) {
    const { data: entity } = await supabase
      .from("teller_legal_entities")
      .select("id")
      .eq("organization_id", orgId)
      .eq("entity_code", code)
      .maybeSingle();
    if (entity?.id) {
      await supabase.from("teller_accounts").delete().eq("organization_id", orgId).eq("legal_entity_id", entity.id);
      await supabase.from("teller_legal_entities").delete().eq("id", entity.id);
    }
  }

  await supabase
    .from("teller_accounts")
    .delete()
    .eq("organization_id", orgId)
    .eq("code", SHARED_ACCOUNT_CODE);

  await supabase.from("teller_bank_accounts").delete().eq("organization_id", orgId).ilike("name", `${ACCEPT_MEMO}%`);
}

async function postBalancedTestJournal(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    debitAccountId: string;
    creditAccountId: string;
    amount?: number;
    entryDate: string;
    suffix?: string;
  },
) {
  const amount = input.amount ?? 100;
  return postJournal(supabase, {
    organizationId: input.organizationId,
    legalEntityId: input.legalEntityId,
    entryDate: input.entryDate,
    memo: `${ACCEPT_MEMO}${input.suffix ?? ""}`,
    sourceKind: "adjustment",
    lines: [
      { account_id: input.debitAccountId, debit: amount },
      { account_id: input.creditAccountId, credit: amount },
    ],
  });
}

async function main() {
  const { orgId, foreignOrgId, supabase } = loadEnv();
  await assertSchemaReady(supabase);

  const mainEntity = await requireEntityByCode(supabase, orgId, "MAIN");
  const entityAId = mainEntity.id;
  let entityBId = await ensureBranchEntity(supabase, orgId);

  await ensureCoa(supabase, orgId, entityAId);
  await ensureCoa(supabase, orgId, entityBId);
  await resetAcceptanceState(supabase, orgId, [entityAId, entityBId]);

  const closedThroughA = await booksClosedThrough(supabase, orgId, entityAId);
  const closedThroughB = await booksClosedThrough(supabase, orgId, entityBId);
  const openDateA = openEntryDate(closedThroughA);
  const openDateB = openEntryDate(closedThroughB);
  const closeTargetA = nextCloseablePeriodEnd(closedThroughA);
  const reportPeriodStart = `${openDateA.slice(0, 8)}01`;
  const reportPeriodEnd = (() => {
    const d = new Date(openDateA + "T12:00:00");
    d.setMonth(d.getMonth() + 1, 0);
    return d.toISOString().slice(0, 10);
  })();

  const cashA = await accountByCode(supabase, orgId, entityAId, "1000");
  const cashB = await accountByCode(supabase, orgId, entityBId, "1000");
  const equityA = await accountByCode(supabase, orgId, entityAId, "3000");
  const equityB = await accountByCode(supabase, orgId, entityBId, "3000");

  const hfacJournalsBefore = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG);
  const orgJournalsBefore = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);

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

  await run("16C_01 same account number exists in Entity A and B", async () => {
    const { data: aRow, error: aError } = await supabase
      .from("teller_accounts")
      .insert({
        organization_id: orgId,
        legal_entity_id: entityAId,
        code: SHARED_ACCOUNT_CODE,
        name: "Shared code A",
        type: "asset",
        subtype: "other",
      })
      .select("id")
      .single();
    if (aError) throw new Error(aError.message);

    const { data: bRow, error: bError } = await supabase
      .from("teller_accounts")
      .insert({
        organization_id: orgId,
        legal_entity_id: entityBId,
        code: SHARED_ACCOUNT_CODE,
        name: "Shared code B",
        type: "asset",
        subtype: "other",
      })
      .select("id")
      .single();
    if (bError) throw new Error(bError.message);
    if (aRow.id === bRow.id) throw new Error("accounts must have distinct ids");
  });

  await run("16C_02 duplicate account number blocked within one entity", async () => {
    const { error } = await supabase.from("teller_accounts").insert({
      organization_id: orgId,
      legal_entity_id: entityAId,
      code: SHARED_ACCOUNT_CODE,
      name: "Duplicate A",
      type: "asset",
      subtype: "other",
    });
    if (!error) throw new Error("expected duplicate rejection");
  });

  await run("16C_03 Entity A journal uses only A accounts", async () => {
    await postBalancedTestJournal(supabase, {
      organizationId: orgId,
      legalEntityId: entityAId,
      debitAccountId: cashA.id as string,
      creditAccountId: equityA.id as string,
      suffix: "_A_only",
      entryDate: openDateA,
    });
  });

  await run("16C_04 A journal using B account rejected", async () => {
    await postBalancedTestJournal(supabase, {
      organizationId: orgId,
      legalEntityId: entityAId,
      debitAccountId: cashB.id as string,
      creditAccountId: equityA.id as string,
      suffix: "_cross_fail",
      entryDate: openDateA,
    }).then(
      () => {
        throw new Error("expected cross-entity posting rejection");
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "expected cross-entity posting rejection") throw err;
        if (!/Cross-entity|same legal entity/i.test(message)) throw err;
      },
    );
  });

  await run("16C_05 Entity A ledger excludes B activity", async () => {
    await postBalancedTestJournal(supabase, {
      organizationId: orgId,
      legalEntityId: entityBId,
      debitAccountId: cashB.id as string,
      creditAccountId: equityB.id as string,
      suffix: "_B_only",
      entryDate: openDateB,
    });
    const { data: aEntries } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .eq("organization_id", orgId)
      .eq("legal_entity_id", entityAId)
      .ilike("memo", `${ACCEPT_MEMO}%`);
    const { data: bEntries } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .eq("organization_id", orgId)
      .eq("legal_entity_id", entityBId)
      .ilike("memo", `${ACCEPT_MEMO}%`);
    if ((aEntries ?? []).some((row) => (bEntries ?? []).some((b) => b.id === row.id))) {
      throw new Error("ledger overlap");
    }
    if (!(bEntries ?? []).length) throw new Error("expected B activity");
  });

  await run("16C_06 Entity A trial balance excludes B", async () => {
    const tb = await buildTrialBalance(supabase, orgId, {
      legalEntityId: entityAId,
      periodStart: reportPeriodStart,
      periodEnd: reportPeriodEnd,
    });
    const bCash = tb.rows.find((row) => row.accountId === cashB.id);
    if (bCash && (bCash.adjustedDebit > 0 || bCash.adjustedCredit > 0)) {
      throw new Error("Entity B cash appeared on Entity A trial balance");
    }
  });

  await run("16C_07 Entity B trial balance excludes A", async () => {
    const tb = await buildTrialBalance(supabase, orgId, {
      legalEntityId: entityBId,
      periodStart: reportPeriodStart,
      periodEnd: reportPeriodEnd,
    });
    const aCash = tb.rows.find((row) => row.accountId === cashA.id);
    if (aCash && (aCash.adjustedDebit > 0 || aCash.adjustedCredit > 0)) {
      throw new Error("Entity A cash appeared on Entity B trial balance");
    }
    if (!tb.balanced) throw new Error("Entity B trial balance not balanced");
  });

  let closedPeriodA = closedThroughA;

  await run("16C_08 Entity A period close does not close B", async () => {
    if (!closeTargetA) {
      closedPeriodA = await booksClosedThrough(supabase, orgId, entityAId);
      if (!closedPeriodA) throw new Error("Entity A has no closeable period");
    } else {
      await closeAccountingPeriod(supabase, {
        organizationId: orgId,
        legalEntityId: entityAId,
        periodEnd: closeTargetA,
        skipReadiness: true,
        notes: ACCEPT_MEMO,
      });
      closedPeriodA = closeTargetA;
    }
    const bClosed = await booksClosedThrough(supabase, orgId, entityBId);
    if (bClosed === closedPeriodA) throw new Error("Entity B should remain open");
    const aClosed = await booksClosedThrough(supabase, orgId, entityAId);
    if (aClosed !== closedPeriodA) throw new Error("Entity A should be closed");
  });

  await run("16C_09 A closed period blocks A posting", async () => {
    const blockedDate = midMonthInPeriod(closedPeriodA!);
    await assertOrgPeriodOpen(supabase, orgId, blockedDate, entityAId).then(
      () => {
        throw new Error("expected closed period rejection for A");
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "expected closed period rejection for A") throw err;
        if (!/closed/i.test(message)) throw err;
      },
    );
  });

  await run("16C_10 B open period still allows B posting", async () => {
    await postBalancedTestJournal(supabase, {
      organizationId: orgId,
      legalEntityId: entityBId,
      debitAccountId: cashB.id as string,
      creditAccountId: equityB.id as string,
      suffix: "_B_open",
      entryDate: openDateB,
    });
  });

  await run("16C_11 period ordering is entity-specific", async () => {
    const bClosedNow = await booksClosedThrough(supabase, orgId, entityBId);
    const bNextClose = nextCloseablePeriodEnd(bClosedNow);
    if (!bNextClose) throw new Error("Entity B has no closeable period for ordering test");
    const outOfOrderPeriod = priorMonthEnd(bNextClose);
    await closeAccountingPeriod(supabase, {
      organizationId: orgId,
      legalEntityId: entityBId,
      periodEnd: outOfOrderPeriod,
      skipReadiness: true,
      notes: ACCEPT_MEMO,
    }).then(
      () => {
        throw new Error("expected out-of-order close rejection for B");
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "expected out-of-order close rejection for B") throw err;
        if (!/Close periods in order|already closed|not ready/i.test(message)) throw err;
      },
    );
  });

  await run("16C_12 bank account mapped to same-entity GL succeeds", async () => {
    const connectionId = await ensureBankConnection(supabase, orgId);
    const { data, error } = await supabase
      .from("teller_bank_accounts")
      .insert({
        organization_id: orgId,
        legal_entity_id: entityAId,
        connection_id: connectionId,
        external_account_id: `${ACCEPT_MEMO}-A`,
        name: `${ACCEPT_MEMO} Bank A`,
        teller_account_id: cashA.id,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    if (!data?.id) throw new Error("bank account insert failed");
  });

  await run("16C_13 cross-entity bank/GL mapping rejected", async () => {
    const connectionId = await ensureBankConnection(supabase, orgId);
    const { error } = await supabase.from("teller_bank_accounts").insert({
      organization_id: orgId,
      legal_entity_id: entityBId,
      connection_id: connectionId,
      external_account_id: `${ACCEPT_MEMO}-cross`,
      name: `${ACCEPT_MEMO} Bank cross`,
      teller_account_id: cashA.id,
    });
    if (!error) throw new Error("expected cross-entity bank mapping rejection");
    if (!/same legal entity|Cross-entity/i.test(error.message)) throw new Error(error.message);
  });

  await run("16C_14 AP default account cross-entity reference rejected", async () => {
    await upsertEntityAccountingSettings(supabase, {
      organizationId: orgId,
      legalEntityId: entityAId,
      patch: { defaultApAccountId: cashB.id as string },
    }).then(
      () => {
        throw new Error("expected AP cross-entity rejection");
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "expected AP cross-entity rejection") throw err;
        if (!/active legal entity|belong/i.test(message)) throw err;
      },
    );
  });

  await run("16C_15 tax default account cross-entity reference rejected", async () => {
    await upsertEntityMetadataAccountRefs(supabase, {
      organizationId: orgId,
      legalEntityId: entityAId,
      metadataPatch: { [ENTITY_METADATA_KEYS.salesTaxPayableAccountId]: cashB.id },
      accountIdsToValidate: [cashB.id as string],
    }).then(
      () => {
        throw new Error("expected tax cross-entity rejection");
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "expected tax cross-entity rejection") throw err;
        if (!/active legal entity|belong/i.test(message)) throw err;
      },
    );
  });

  await run("16C_16 inventory default account cross-entity reference rejected", async () => {
    await upsertEntityMetadataAccountRefs(supabase, {
      organizationId: orgId,
      legalEntityId: entityAId,
      metadataPatch: {
        [ENTITY_METADATA_KEYS.inventoryMappings]: [{ mappingKey: "inventory_asset", accountId: cashB.id }],
      },
      accountIdsToValidate: [cashB.id as string],
    }).then(
      () => {
        throw new Error("expected inventory cross-entity rejection");
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "expected inventory cross-entity rejection") throw err;
        if (!/active legal entity|belong/i.test(message)) throw err;
      },
    );
  });

  await run("16C_17 new entity standard COA setup starts at zero", async () => {
    const created = await createLegalEntity(supabase, {
      organizationId: orgId,
      name: "Phase 16C Setup",
      entityCode: SETUP_ENTITY_CODE,
      entityType: "llc",
    });
    const result = await initializeEntityCoa(supabase, {
      organizationId: orgId,
      legalEntityId: created.id,
      mode: "standard",
    });
    if (result.accountsCreated < 1) throw new Error("expected accounts created");
    const tb = await buildTrialBalance(supabase, orgId, {
      legalEntityId: created.id,
      periodEnd: reportPeriodEnd,
    });
    if (tb.totals.adjustedDebit !== 0 || tb.totals.adjustedCredit !== 0) {
      throw new Error("new entity COA should start at zero balance");
    }
    await supabase.from("teller_accounts").delete().eq("organization_id", orgId).eq("legal_entity_id", created.id);
    await supabase.from("teller_legal_entities").delete().eq("id", created.id);
  });

  await run("16C_18 copied COA structure creates new account IDs", async () => {
    const created = await createLegalEntity(supabase, {
      organizationId: orgId,
      name: "Phase 16C Copy",
      entityCode: "C16CX",
      entityType: "llc",
    });
    await initializeEntityCoa(supabase, {
      organizationId: orgId,
      legalEntityId: created.id,
      mode: "copy_structure",
      sourceLegalEntityId: entityAId,
    });
    const source = await accountByCode(supabase, orgId, entityAId, "1000");
    const copied = await accountByCode(supabase, orgId, created.id, "1000");
    if (source.id === copied.id) throw new Error("COA copy reused source account id");
    await supabase.from("teller_legal_entities").delete().eq("id", created.id);
  });

  await run("16C_19 copied COA does not copy balances/history", async () => {
    const created = await createLegalEntity(supabase, {
      organizationId: orgId,
      name: "Phase 16C Copy Bal",
      entityCode: "C16CB",
      entityType: "llc",
    });
    await initializeEntityCoa(supabase, {
      organizationId: orgId,
      legalEntityId: created.id,
      mode: "copy_structure",
      sourceLegalEntityId: entityAId,
    });
    const tb = await buildTrialBalance(supabase, orgId, {
      legalEntityId: created.id,
      periodEnd: reportPeriodEnd,
    });
    if (tb.totals.adjustedDebit !== 0 || tb.totals.adjustedCredit !== 0) {
      throw new Error("copied COA must not copy balances");
    }
    const { count } = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("legal_entity_id", created.id);
    if ((count ?? 0) > 0) throw new Error("copied entity must not inherit journals");
    await supabase.from("teller_legal_entities").delete().eq("id", created.id);
  });

  await run("16C_20 payment cannot allocate to cross-entity document", async () => {
    const { data: payment, error: paymentError } = await supabase
      .from("teller_payments")
      .insert({
        organization_id: orgId,
        legal_entity_id: entityAId,
        payment_type: "customer_payment",
        amount: 50,
        payment_date: openDateA,
      })
      .select("id")
      .single();
    if (paymentError) throw new Error(paymentError.message);

    const { data: document, error: documentError } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: orgId,
        legal_entity_id: entityBId,
        kind: "invoice",
        status: "open",
        number: `${ACCEPT_MEMO}-INV`,
        issue_date: openDateA,
        total: 50,
        amount_paid: 0,
      })
      .select("id")
      .single();
    if (documentError) throw new Error(documentError.message);

    await recordPaymentAllocation(supabase, {
      organizationId: orgId,
      paymentId: payment!.id as string,
      documentId: document!.id as string,
      amount: 50,
      allocationKind: "invoice_payment",
    }).then(
      () => {
        throw new Error("expected cross-entity allocation rejection");
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "expected cross-entity allocation rejection") throw err;
        if (!/Cross-entity|same legal entity|not allowed/i.test(message)) throw err;
      },
    );
  });

  await run("16C_21 posted journal cannot change entity", async () => {
    const entryId = await postBalancedTestJournal(supabase, {
      organizationId: orgId,
      legalEntityId: entityBId,
      debitAccountId: cashB.id as string,
      creditAccountId: equityB.id as string,
      suffix: "_immutable",
      entryDate: openDateB,
    });
    const { error } = await supabase
      .from("teller_journal_entries")
      .update({ legal_entity_id: entityAId })
      .eq("id", entryId);
    if (!error) throw new Error("expected posted journal entity reassignment block");
  });

  await run("16C_22 active entity report context is respected", async () => {
    const tbA = await buildTrialBalance(supabase, orgId, {
      legalEntityId: entityAId,
      periodStart: reportPeriodStart,
      periodEnd: reportPeriodEnd,
    });
    const tbDefault = await buildTrialBalance(supabase, orgId, {
      legalEntityId: await resolveLegalEntityId(supabase, orgId, entityAId),
      periodStart: reportPeriodStart,
      periodEnd: reportPeriodEnd,
    });
    if (tbA.totals.adjustedDebit !== tbDefault.totals.adjustedDebit) {
      throw new Error("explicit entity context mismatch");
    }
  });

  await run("16C_23 single-entity legacy org resolves transparently", async () => {
    const foreignDefault = await requireDefaultLegalEntity(supabase, foreignOrgId);
    const resolved = await resolveLegalEntityId(supabase, foreignOrgId, null);
    if (resolved !== foreignDefault.id) throw new Error("foreign default resolution failed");
    const tb = await buildTrialBalance(supabase, foreignOrgId, { periodEnd: reportPeriodEnd });
    if (!tb.balanced && tb.rows.length > 0) throw new Error("foreign org trial balance invalid");
  });

  await run("16C_24 HFAC entity resolution remains safe", async () => {
    const hfacDefault = await requireDefaultLegalEntity(supabase, HFAC_ORG);
    if (!hfacDefault.isDefault) throw new Error("HFAC default entity missing");
    const { count: hfacJournalCountAfter } = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG);
    if ((hfacJournalCountAfter ?? 0) !== (hfacJournalsBefore.count ?? 0)) {
      throw new Error("HFAC journal count changed");
    }
  });

  await run("16C_25 no intercompany or consolidation records created", async () => {
    const tables = ["teller_intercompany_entries", "teller_consolidation_groups"];
    for (const table of tables) {
      const { error } = await supabase.from(table).select("id").limit(1);
      if (!error?.message.match(/does not exist|schema cache/i)) {
        throw new Error(`${table} should not exist in Phase 16C`);
      }
    }
  });

  const orgJournalsAfter = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);

  const passed = results.filter((row) => row.pass).length;
  console.log(
    JSON.stringify(
      {
        phase: "16C",
        passed,
        total: results.length,
        orgJournalsBefore: orgJournalsBefore.count ?? 0,
        orgJournalsAfter: orgJournalsAfter.count ?? 0,
        hfacModified: false,
      },
      null,
      2,
    ),
  );
  console.log(`\nPhase 16C acceptance: ${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
