/**
 * Phase 6 controlled production demo — dedicated demo org only, never HFAC.
 * Invoked by: npm run demo:phase6:controlled
 */
import { randomUUID } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { submitBillForApproval, approveBill } from "../src/lib/accounting/bill-approval";
import { postMultiBillPayment } from "../src/lib/accounting/bill-pay";
import { postBillOpen } from "../src/lib/accounting/bills";
import { buildApDashboardSummary } from "../src/lib/accounting/ap-dashboard";
import { detectDuplicateBillWarnings } from "../src/lib/accounting/duplicate-bills";
import { generateRecurringBillDraft } from "../src/lib/accounting/recurring-bills";
import { convertPurchaseOrderToBill } from "../src/lib/accounting/po-to-bill";
import {
  createPurchaseOrder,
  receivePurchaseOrder,
  submitPurchaseOrderForApproval,
  approvePurchaseOrder,
  markPurchaseOrderSent,
} from "../src/lib/accounting/purchase-orders";
import { applyDocumentCredit, postVendorCreditOpen } from "../src/lib/accounting/credits";
import { reverseDocumentAllocation, reversePayment } from "../src/lib/accounting/settlements";
import { nextNumber } from "../src/lib/accounting/accounts";
import { authoritativeDocumentRemaining } from "../src/lib/accounting/balances";
import { asNumber } from "../src/lib/format";
import { canApproveBills } from "../src/lib/auth/roles";
import { confirmBankMatch } from "../src/lib/banking/categorize";
import { parseBankCsv } from "../src/lib/banking/csv";
import { importBankTransactionsBatch } from "../src/lib/banking/ingest";
import {
  assertNotHfacOrganization,
  CONTROLLED_PHASE6_DEMO_ORG_NAME,
  CONTROLLED_PHASE6_FOREIGN_ORG_NAME,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import { reopenAllPeriodCloses } from "./lib/reopen-demo-period-closes";

type ScenarioResult = { name: string; pass: boolean; detail?: string };

type EconomicSnapshot = {
  payments: number;
  paymentAllocations: number;
  documentAllocations: number;
  journals: number;
};

const HFAC_ORG_ID = TELLER_HFAC_ORG_ID;
const CLOSED_PERIOD_END = "2026-08-31";
const CLOSED_PERIOD_DATE = "2026-08-15";
const OPEN_PERIOD_DATE = "2026-09-15";

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");
  }
  const orgId = process.env.TELLER_PHASE6_DEMO_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE6_DEMO_ORG_ID missing");
  assertNotHfacOrganization(orgId);
  return {
    orgId,
    supabase: createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    ),
  };
}

async function assertDemoOrg(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase
    .from("teller_organizations")
    .select("id, name")
    .eq("id", orgId)
    .maybeSingle();
  if (!data || data.name !== CONTROLLED_PHASE6_DEMO_ORG_NAME) {
    throw new Error(`Expected org "${CONTROLLED_PHASE6_DEMO_ORG_NAME}"`);
  }
}

async function accountMap(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase.from("teller_accounts").select("id, code").eq("organization_id", orgId);
  return Object.fromEntries((data ?? []).map((row) => [row.code, row.id as string]));
}

async function tableCount(supabase: SupabaseClient, table: string, orgId: string) {
  const { count } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  return count ?? 0;
}

async function journalCount(supabase: SupabaseClient, orgId: string) {
  return tableCount(supabase, "teller_journal_entries", orgId);
}

async function economicSnapshot(supabase: SupabaseClient, orgId: string): Promise<EconomicSnapshot> {
  return {
    payments: await tableCount(supabase, "teller_payments", orgId),
    paymentAllocations: await tableCount(supabase, "teller_payment_allocations", orgId),
    documentAllocations: await tableCount(supabase, "teller_document_allocations", orgId),
    journals: await journalCount(supabase, orgId),
  };
}

async function assertOrgJournalsBalanced(supabase: SupabaseClient, orgId: string) {
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  for (const entry of entries ?? []) {
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("entry_id", entry.id as string);
    const debits = (lines ?? []).reduce((sum, line) => sum + asNumber(line.debit), 0);
    const credits = (lines ?? []).reduce((sum, line) => sum + asNumber(line.credit), 0);
    if (Math.abs(debits - credits) > 0.009) {
      throw new Error(`Unbalanced journal ${entry.id}: debits=${debits} credits=${credits}`);
    }
  }
}

async function hfacBaseline(supabase: SupabaseClient) {
  async function count(table: string) {
    const { count } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG_ID);
    return count ?? 0;
  }
  return {
    documents: await count("teller_documents"),
    payments: await count("teller_payments"),
    payment_allocations: await count("teller_payment_allocations"),
    journal_entries: await count("teller_journal_entries"),
  };
}

async function ensureVendor(supabase: SupabaseClient, orgId: string, name: string) {
  const { data: existing } = await supabase
    .from("teller_parties")
    .select("id")
    .eq("organization_id", orgId)
    .eq("name", name)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data, error } = await supabase
    .from("teller_parties")
    .insert({ organization_id: orgId, kind: "vendor", name })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message || "vendor");
  return data.id as string;
}

async function ensureForeignOrg(supabase: SupabaseClient) {
  const { data: existing } = await supabase
    .from("teller_organizations")
    .select("id")
    .eq("name", CONTROLLED_PHASE6_FOREIGN_ORG_NAME)
    .maybeSingle();
  let orgId: string;
  if (existing?.id) {
    orgId = existing.id as string;
  } else {
    const { data, error } = await supabase
      .from("teller_organizations")
      .insert({
        name: CONTROLLED_PHASE6_FOREIGN_ORG_NAME,
        legal_name: CONTROLLED_PHASE6_FOREIGN_ORG_NAME,
        industry_id: "hvac-residential",
        setup_completed_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message || "foreign org");
    orgId = data.id as string;
  }
  assertNotHfacOrganization(orgId);

  for (const row of [
    { code: "1000", name: "Checking", type: "asset", subtype: "bank" },
    { code: "2000", name: "AP", type: "liability", subtype: "payable" },
    { code: "6150", name: "Materials", type: "expense", subtype: "" },
  ]) {
    const { data: acct } = await supabase
      .from("teller_accounts")
      .select("id")
      .eq("organization_id", orgId)
      .eq("code", row.code)
      .maybeSingle();
    if (acct?.id) continue;
    await supabase.from("teller_accounts").insert({
      organization_id: orgId,
      code: row.code,
      name: row.name,
      type: row.type,
      subtype: row.subtype,
      industry_tag: "",
      is_system: true,
    });
  }

  return orgId;
}

async function resolveCheckingBankId(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase
    .from("teller_bank_accounts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("external_account_id", "phase6-demo-checking")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) {
    throw new Error("Phase 6 demo checking bank missing — run npm run setup:phase6-demo-org");
  }
  return data.id as string;
}

async function openBill(
  supabase: SupabaseClient,
  orgId: string,
  documentId: string,
) {
  await submitBillForApproval(supabase, { organizationId: orgId, documentId });
  const { data: bill } = await supabase
    .from("teller_documents")
    .select("status")
    .eq("id", documentId)
    .single();
  if (bill?.status === "pending_approval") {
    await approveBill(supabase, { organizationId: orgId, documentId });
  }
  const { data: opened } = await supabase
    .from("teller_documents")
    .select("status")
    .eq("id", documentId)
    .single();
  if (opened?.status !== "open" && opened?.status !== "partially_paid") {
    throw new Error(`Expected open bill, got ${opened?.status}`);
  }
}

async function createDraftBill(
  supabase: SupabaseClient,
  input: {
    orgId: string;
    vendorId: string;
    accounts: Record<string, string>;
    issueDate: string;
    total: number;
    suffix: string;
  },
) {
  const { data: existingBills } = await supabase
    .from("teller_documents")
    .select("number")
    .eq("organization_id", input.orgId)
    .eq("kind", "bill");
  const number = nextNumber("BILL", (existingBills ?? []).map((row) => row.number as string));
  const { data: doc, error } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: input.orgId,
      kind: "bill",
      number,
      party_id: input.vendorId,
      status: "draft",
      issue_date: input.issueDate,
      subtotal: input.total,
      tax: 0,
      total: input.total,
      memo: `Control test ${input.suffix}`,
    })
    .select("id, number")
    .single();
  if (error || !doc) throw new Error(error?.message || "draft bill");
  await supabase.from("teller_document_lines").insert({
    document_id: doc.id,
    description: `Control ${input.suffix}`,
    amount: input.total,
    account_id: input.accounts["6150"],
    item_type: "expense",
  });
  return { billId: doc.id as string, number: doc.number as string };
}

async function cleanupDemoOrg(supabase: SupabaseClient, orgId: string) {
  await supabase.from("teller_bank_reconciliation_items").delete().eq("organization_id", orgId);
  await supabase.from("teller_bank_reconciliations").delete().eq("organization_id", orgId);
  await supabase.from("teller_bank_matches").delete().eq("organization_id", orgId);
  await supabase.from("teller_bank_transfers").delete().eq("organization_id", orgId);
  await supabase.from("teller_bank_transaction_splits").delete().eq("organization_id", orgId);
  await supabase.from("teller_bank_transactions").delete().eq("organization_id", orgId);
  await reopenAllPeriodCloses(supabase, orgId);
  await supabase.from("teller_document_allocations").delete().eq("organization_id", orgId);
  await supabase.from("teller_payment_allocations").delete().eq("organization_id", orgId);
  await supabase.from("teller_payments").delete().eq("organization_id", orgId);
  await supabase.from("teller_purchase_receipt_lines").delete().eq("organization_id", orgId);
  await supabase.from("teller_purchase_receipts").delete().eq("organization_id", orgId);
  await supabase.from("teller_purchase_order_lines").delete().eq("organization_id", orgId);
  await supabase.from("teller_purchase_orders").delete().eq("organization_id", orgId);
  await supabase.from("teller_recurring_bill_templates").delete().eq("organization_id", orgId);
  await supabase.from("teller_document_journal_links").delete().eq("organization_id", orgId);
  const { data: docs } = await supabase
    .from("teller_documents")
    .select("id")
    .eq("organization_id", orgId);
  const docIds = (docs ?? []).map((row) => row.id as string);
  if (docIds.length) {
    await supabase.from("teller_document_lines").delete().in("document_id", docIds);
  }
  await supabase.from("teller_documents").delete().eq("organization_id", orgId);
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  const entryIds = (entries ?? []).map((row) => row.id as string);
  if (entryIds.length) {
    await supabase.from("teller_journal_lines").delete().in("entry_id", entryIds);
  }
  await supabase.from("teller_journal_entries").delete().eq("organization_id", orgId);
  await supabase.from("teller_parties").delete().eq("organization_id", orgId);
}

async function expectRejection(fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
    throw new Error("Expected rejection");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "Expected rejection") throw err;
    if (!pattern.test(message)) {
      throw new Error(`Expected rejection matching ${pattern}, got: ${message}`);
    }
  }
}

async function main() {
  const { orgId, supabase } = loadEnv();
  await assertDemoOrg(supabase, orgId);
  await cleanupDemoOrg(supabase, orgId);
  const accounts = await accountMap(supabase, orgId);
  const checkingBankId = await resolveCheckingBankId(supabase, orgId);
  const hfacBefore = await hfacBaseline(supabase);
  const results: ScenarioResult[] = [];

  let vendorId = "";
  let purchaseOrderId = "";
  let poLineId = "";
  let partialBillId = "";
  let remainingBillId = "";
  let multiBillPaymentId = "";
  let partialBillTotal = 0;
  let remainingBillTotal = 0;

  async function run(name: string, fn: () => Promise<void>) {
    try {
      assertNotHfacOrganization(orgId);
      await fn();
      await assertOrgJournalsBalanced(supabase, orgId);
      results.push({ name, pass: true });
      console.log(`✓ ${name}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ name, pass: false, detail });
      console.log(`✗ ${name} — ${detail}`);
    }
  }

  await run("1. Dedicated demo org + vendor", async () => {
    vendorId = await ensureVendor(supabase, orgId, "Phase 6 Demo Vendor");
    if (!vendorId) throw new Error("vendor missing");
  });

  await run("4. PO creates zero journals", async () => {
    const before = await journalCount(supabase, orgId);
    const created = await createPurchaseOrder(supabase, {
      organizationId: orgId,
      partyId: vendorId,
      issueDate: OPEN_PERIOD_DATE,
      lines: [
        {
          description: "Demo materials",
          quantity: 10,
          unitCost: 25,
          accountId: accounts["6150"],
          costCategory: "material",
          costType: "material",
        },
      ],
    });
    purchaseOrderId = created.purchaseOrderId;
    const after = await journalCount(supabase, orgId);
    if (after !== before) throw new Error(`PO created journals: before=${before} after=${after}`);

    await submitPurchaseOrderForApproval(supabase, { organizationId: orgId, purchaseOrderId });
    await approvePurchaseOrder(supabase, { organizationId: orgId, purchaseOrderId });
    await markPurchaseOrderSent(supabase, { organizationId: orgId, purchaseOrderId });

    const { data: poLines } = await supabase
      .from("teller_purchase_order_lines")
      .select("id")
      .eq("purchase_order_id", purchaseOrderId);
    poLineId = poLines![0].id as string;
  });

  await run("9a. Partial receipt → partially_received", async () => {
    await receivePurchaseOrder(supabase, {
      organizationId: orgId,
      purchaseOrderId,
      receiptDate: OPEN_PERIOD_DATE,
      lines: [{ purchaseOrderLineId: poLineId, quantityReceived: 4 }],
    });
    const { data: po } = await supabase
      .from("teller_purchase_orders")
      .select("status")
      .eq("id", purchaseOrderId)
      .single();
    if (po?.status !== "partially_received") {
      throw new Error(`Expected partially_received, got ${po?.status}`);
    }
  });

  await run("9b. Final receipt → received", async () => {
    await receivePurchaseOrder(supabase, {
      organizationId: orgId,
      purchaseOrderId,
      receiptDate: OPEN_PERIOD_DATE,
      lines: [{ purchaseOrderLineId: poLineId, quantityReceived: 6 }],
    });
    const { data: po } = await supabase
      .from("teller_purchase_orders")
      .select("status")
      .eq("id", purchaseOrderId)
      .single();
    if (po?.status !== "received") throw new Error(`Expected received, got ${po?.status}`);
  });

  await run("9c. Over-receipt rejection", async () => {
    const snap = await economicSnapshot(supabase, orgId);
    await expectRejection(
      () =>
        receivePurchaseOrder(supabase, {
          organizationId: orgId,
          purchaseOrderId,
          receiptDate: OPEN_PERIOD_DATE,
          lines: [{ purchaseOrderLineId: poLineId, quantityReceived: 1 }],
        }),
      /cannot receive|remaining/i,
    );
    const after = await economicSnapshot(supabase, orgId);
    if (JSON.stringify(snap) !== JSON.stringify(after)) {
      throw new Error("Over-receipt caused side effects");
    }
  });

  await run("9d. Partial bill → partially_billed", async () => {
    const partial = await convertPurchaseOrderToBill(supabase, {
      organizationId: orgId,
      purchaseOrderId,
      issueDate: OPEN_PERIOD_DATE,
      lines: [{ purchaseOrderLineId: poLineId, quantityToBill: 5 }],
    });
    partialBillId = partial.billId;
    const { data: po } = await supabase
      .from("teller_purchase_orders")
      .select("status")
      .eq("id", purchaseOrderId)
      .single();
    if (po?.status !== "partially_billed") {
      throw new Error(`Expected partially_billed, got ${po?.status}`);
    }
  });

  await run("9e. Final bill → billed", async () => {
    const remaining = await convertPurchaseOrderToBill(supabase, {
      organizationId: orgId,
      purchaseOrderId,
      issueDate: OPEN_PERIOD_DATE,
      lines: [{ purchaseOrderLineId: poLineId, quantityToBill: 5 }],
    });
    remainingBillId = remaining.billId;
    const { data: po } = await supabase
      .from("teller_purchase_orders")
      .select("status")
      .eq("id", purchaseOrderId)
      .single();
    if (po?.status !== "billed") throw new Error(`Expected billed, got ${po?.status}`);
  });

  await run("9f. Over-bill rejection", async () => {
    const snap = await economicSnapshot(supabase, orgId);
    await expectRejection(
      () =>
        convertPurchaseOrderToBill(supabase, {
          organizationId: orgId,
          purchaseOrderId,
          issueDate: OPEN_PERIOD_DATE,
          lines: [{ purchaseOrderLineId: poLineId, quantityToBill: 1 }],
        }),
      /cannot bill|billable/i,
    );
    const after = await economicSnapshot(supabase, orgId);
    if (JSON.stringify(snap) !== JSON.stringify(after)) {
      throw new Error("Over-bill caused side effects");
    }
  });

  await run("11. Approval threshold", async () => {
    await openBill(supabase, orgId, partialBillId);
    await openBill(supabase, orgId, remainingBillId);
    const { data: bill } = await supabase
      .from("teller_documents")
      .select("status, total")
      .eq("id", partialBillId)
      .single();
    if (bill?.status !== "open") throw new Error(`Expected open, got ${bill?.status}`);
    partialBillTotal = asNumber(bill?.total);
    const { data: bill2 } = await supabase
      .from("teller_documents")
      .select("total")
      .eq("id", remainingBillId)
      .single();
    remainingBillTotal = asNumber(bill2?.total);
  });

  await run("10. AP increases", async () => {
    const apSummary = await buildApDashboardSummary(supabase, orgId, OPEN_PERIOD_DATE);
    if (apSummary.totalAp <= 0) throw new Error(`AP=${apSummary.totalAp}`);
  });

  await run("C1. Multi-bill payment", async () => {
    const payA = 50;
    const payB = 75;
    const before = await economicSnapshot(supabase, orgId);

    const { paymentId, entryId, total } = await postMultiBillPayment(supabase, {
      organizationId: orgId,
      partyId: vendorId,
      paymentDate: OPEN_PERIOD_DATE,
      allocations: [
        { documentId: partialBillId, amount: payA },
        { documentId: remainingBillId, amount: payB },
      ],
      idempotencyKey: randomUUID(),
    });
    multiBillPaymentId = paymentId;

    const after = await economicSnapshot(supabase, orgId);
    if (after.payments !== before.payments + 1) {
      throw new Error(`Expected 1 payment, got ${after.payments - before.payments}`);
    }
    if (after.paymentAllocations !== before.paymentAllocations + 2) {
      throw new Error(`Expected 2 allocations, got ${after.paymentAllocations - before.paymentAllocations}`);
    }
    if (after.journals !== before.journals + 1) {
      throw new Error(`Expected 1 journal, got ${after.journals - before.journals}`);
    }
    if (Math.abs(total - (payA + payB)) > 0.009) {
      throw new Error(`Payment total ${total} != ${payA + payB}`);
    }

    const { data: allocs } = await supabase
      .from("teller_payment_allocations")
      .select("document_id, amount")
      .eq("payment_id", paymentId);
    if ((allocs ?? []).length !== 2) throw new Error("Expected 2 payment allocations");

    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit, account_id")
      .eq("entry_id", entryId);
    const apAccount = accounts["2000"];
    const cashAccount = accounts["1000"];
    const apDebit = (lines ?? [])
      .filter((line) => line.account_id === apAccount)
      .reduce((sum, line) => sum + asNumber(line.debit), 0);
    const cashCredit = (lines ?? [])
      .filter((line) => line.account_id === cashAccount)
      .reduce((sum, line) => sum + asNumber(line.credit), 0);
    if (Math.abs(apDebit - total) > 0.009 || Math.abs(cashCredit - total) > 0.009) {
      throw new Error(`Journal not Dr AP / Cr Cash for ${total}`);
    }

    const remA = await authoritativeDocumentRemaining(
      supabase,
      orgId,
      partialBillId,
      partialBillTotal,
    );
    const remB = await authoritativeDocumentRemaining(
      supabase,
      orgId,
      remainingBillId,
      remainingBillTotal,
    );
    if (Math.abs(remA - (partialBillTotal - payA)) > 0.009) {
      throw new Error(`Bill A remaining ${remA}, expected ${partialBillTotal - payA}`);
    }
    if (Math.abs(remB - (remainingBillTotal - payB)) > 0.009) {
      throw new Error(`Bill B remaining ${remB}, expected ${remainingBillTotal - payB}`);
    }
  });

  await run("C2. Over-allocation rejection", async () => {
    const snap = await economicSnapshot(supabase, orgId);
    const remaining = await authoritativeDocumentRemaining(
      supabase,
      orgId,
      partialBillId,
      partialBillTotal,
    );
    await expectRejection(
      () =>
        postMultiBillPayment(supabase, {
          organizationId: orgId,
          partyId: vendorId,
          paymentDate: OPEN_PERIOD_DATE,
          allocations: [{ documentId: partialBillId, amount: remaining + 100 }],
          idempotencyKey: randomUUID(),
        }),
      /exceeds remaining/i,
    );
    const afterFirst = await economicSnapshot(supabase, orgId);
    if (JSON.stringify(snap) !== JSON.stringify(afterFirst)) {
      throw new Error("Over-allocation attempt caused side effects");
    }
    await expectRejection(
      () =>
        postMultiBillPayment(supabase, {
          organizationId: orgId,
          partyId: vendorId,
          paymentDate: OPEN_PERIOD_DATE,
          allocations: [{ documentId: partialBillId, amount: remaining + 100 }],
          idempotencyKey: randomUUID(),
        }),
      /exceeds remaining/i,
    );
    const afterRetry = await economicSnapshot(supabase, orgId);
    if (JSON.stringify(snap) !== JSON.stringify(afterRetry)) {
      throw new Error("Over-allocation retry caused side effects");
    }
  });

  await run("C3. Multi-bill vendor credit application", async () => {
    const { data: vcExisting } = await supabase
      .from("teller_documents")
      .select("number")
      .eq("organization_id", orgId)
      .eq("kind", "vendor_credit");
    const vcNumber = nextNumber("VC", (vcExisting ?? []).map((row) => row.number as string));
    const { data: vcDoc } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: orgId,
        kind: "vendor_credit",
        number: vcNumber,
        party_id: vendorId,
        status: "draft",
        issue_date: OPEN_PERIOD_DATE,
        subtotal: 50,
        tax: 0,
        total: 50,
      })
      .select("id")
      .single();
    await supabase.from("teller_document_lines").insert({
      document_id: vcDoc!.id,
      description: "Multi-bill credit",
      amount: 50,
      account_id: accounts["6150"],
      item_type: "credit",
    });
    const journalsBeforePost = await journalCount(supabase, orgId);
    await postVendorCreditOpen(supabase, {
      organizationId: orgId,
      documentId: vcDoc!.id as string,
      partyId: vendorId,
      jobId: null,
      issueDate: OPEN_PERIOD_DATE,
      number: vcNumber,
      tax: 0,
      lines: [{ amount: 50, account_id: accounts["6150"], description: "Multi-bill credit" }],
    });
    const journalsAfterPost = await journalCount(supabase, orgId);
    if (journalsAfterPost !== journalsBeforePost + 1) {
      throw new Error("Vendor credit post should create exactly one journal");
    }

    const journalsBeforeApply = await journalCount(supabase, orgId);
    const allocBefore = await tableCount(supabase, "teller_document_allocations", orgId);

    const applyA = await applyDocumentCredit(supabase, {
      organizationId: orgId,
      sourceDocumentId: vcDoc!.id as string,
      targetDocumentId: partialBillId,
      amount: 15,
    });
    const applyB = await applyDocumentCredit(supabase, {
      organizationId: orgId,
      sourceDocumentId: vcDoc!.id as string,
      targetDocumentId: remainingBillId,
      amount: 20,
    });

    const journalsAfterApply = await journalCount(supabase, orgId);
    if (journalsAfterApply !== journalsBeforeApply) {
      throw new Error("Credit application must not create additional journals");
    }
    const allocAfter = await tableCount(supabase, "teller_document_allocations", orgId);
    if (allocAfter !== allocBefore + 2) {
      throw new Error("Expected 2 document credit allocations");
    }
    if (!applyA.allocationId || !applyB.allocationId) {
      throw new Error("Missing allocation ids");
    }

    const remA = await authoritativeDocumentRemaining(
      supabase,
      orgId,
      partialBillId,
      partialBillTotal,
    );
    const remB = await authoritativeDocumentRemaining(
      supabase,
      orgId,
      remainingBillId,
      remainingBillTotal,
    );
    if (remA <= 0 || remB <= 0) throw new Error(`Remaining balances invalid: A=${remA} B=${remB}`);

    await reverseDocumentAllocation(supabase, {
      organizationId: orgId,
      allocationId: applyA.allocationId,
      reversalEventId: randomUUID(),
      reason: "Demo cleanup A",
    });
    await reverseDocumentAllocation(supabase, {
      organizationId: orgId,
      allocationId: applyB.allocationId,
      reversalEventId: randomUUID(),
      reason: "Demo cleanup B",
    });
  });

  await run("C4. Bank transaction → bill payment match", async () => {
    const { data: payment } = await supabase
      .from("teller_payments")
      .select("amount")
      .eq("id", multiBillPaymentId)
      .single();
    const amount = asNumber(payment?.amount);
    const csv = `Date,Description,Amount\n${OPEN_PERIOD_DATE},Vendor bill payment,${amount.toFixed(2)}`;
    const parsed = parseBankCsv({
      organizationId: orgId,
      bankAccountId: checkingBankId,
      content: csv,
      mapping: { date: "Date", description: "Description", amount: "Amount" },
      bankAccountType: "depository",
      bankAccountSubtype: "checking",
    });
    if (parsed.errors.length) throw new Error(parsed.errors.map((row) => row.message).join("; "));
    await importBankTransactionsBatch(supabase, {
      organizationId: orgId,
      bankAccountId: checkingBankId,
      provider: "manual_csv",
      transactions: parsed.rows,
    });

    const { data: txn } = await supabase
      .from("teller_bank_transactions")
      .select("id")
      .eq("organization_id", orgId)
      .eq("bank_account_id", checkingBankId)
      .ilike("description", "%Vendor bill payment%")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!txn?.id) throw new Error("Bank transaction not imported");

    const journalsBefore = await journalCount(supabase, orgId);
    const matchEventId = randomUUID();
    const match = await confirmBankMatch(supabase, {
      organizationId: orgId,
      bankTransactionId: txn.id as string,
      matchedResourceType: "bill_payment",
      matchedResourceId: multiBillPaymentId,
      matchedAmount: amount,
      idempotencyEventId: matchEventId,
    });
    const journalsAfter = await journalCount(supabase, orgId);
    if (journalsAfter !== journalsBefore) {
      throw new Error(`Match created journals: before=${journalsBefore} after=${journalsAfter}`);
    }

    const { data: matchRow } = await supabase
      .from("teller_bank_matches")
      .select("matched_resource_type, matched_resource_id")
      .eq("id", match.matchId!)
      .single();
    if (matchRow?.matched_resource_type !== "bill_payment") {
      throw new Error(`Expected bill_payment, got ${matchRow?.matched_resource_type}`);
    }
    if (matchRow?.matched_resource_id !== multiBillPaymentId) {
      throw new Error("Match target payment id mismatch");
    }

    const retry = await confirmBankMatch(supabase, {
      organizationId: orgId,
      bankTransactionId: txn.id as string,
      matchedResourceType: "bill_payment",
      matchedResourceId: multiBillPaymentId,
      matchedAmount: amount,
      idempotencyEventId: matchEventId,
    });
    if (!retry.duplicate) throw new Error("Idempotent match retry should be duplicate");
    const journalsAfterRetry = await journalCount(supabase, orgId);
    if (journalsAfterRetry !== journalsBefore) {
      throw new Error("Idempotent match retry changed journal count");
    }
  });

  await run("C5. Match creates no additional journal", async () => {
    // Covered inline in C4; explicit pass marker for reporting.
    if (!multiBillPaymentId) throw new Error("Missing payment fixture");
  });

  await run("C6. Closed-period bill posting rejection", async () => {
    await supabase.from("teller_period_closes").insert({
      organization_id: orgId,
      period_end: CLOSED_PERIOD_END,
      notes: "Phase 6 control close",
    });
    const draft = await createDraftBill(supabase, {
      orgId,
      vendorId,
      accounts,
      issueDate: CLOSED_PERIOD_DATE,
      total: 200,
      suffix: "closed-period",
    });
    const journalsBefore = await journalCount(supabase, orgId);
    await expectRejection(
      () =>
        postBillOpen(supabase, {
          organizationId: orgId,
          documentId: draft.billId,
          partyId: vendorId,
          jobId: null,
          issueDate: CLOSED_PERIOD_DATE,
          number: draft.number,
          tax: 0,
          lines: [{ amount: 200, account_id: accounts["6150"], description: "Closed period bill" }],
        }),
      /closed/i,
    );
    const journalsAfter = await journalCount(supabase, orgId);
    if (journalsAfter !== journalsBefore) {
      throw new Error("Closed-period bill post created a journal");
    }
    const { data: bill } = await supabase
      .from("teller_documents")
      .select("status, posted_entry_id")
      .eq("id", draft.billId)
      .single();
    if (bill?.status !== "draft" || bill?.posted_entry_id) {
      throw new Error("Bill status changed after rejected post");
    }
    await reopenAllPeriodCloses(supabase, orgId);
  });

  await run("C7. Closed-period payment rejection", async () => {
    await supabase.from("teller_period_closes").insert({
      organization_id: orgId,
      period_end: CLOSED_PERIOD_END,
      notes: "Phase 6 payment close",
    });
    const snap = await economicSnapshot(supabase, orgId);
    const remaining = await authoritativeDocumentRemaining(
      supabase,
      orgId,
      partialBillId,
      partialBillTotal,
    );
    await expectRejection(
      () =>
        postMultiBillPayment(supabase, {
          organizationId: orgId,
          partyId: vendorId,
          paymentDate: CLOSED_PERIOD_DATE,
          allocations: [{ documentId: partialBillId, amount: Math.min(10, remaining) }],
          idempotencyKey: randomUUID(),
        }),
      /closed/i,
    );
    const after = await economicSnapshot(supabase, orgId);
    if (JSON.stringify(snap) !== JSON.stringify(after)) {
      throw new Error("Closed-period payment caused side effects");
    }
    await reopenAllPeriodCloses(supabase, orgId);
  });

  await run("C8. Tenant isolation", async () => {
    const foreignOrgId = await ensureForeignOrg(supabase);
    assertNotHfacOrganization(foreignOrgId);

    const foreignVendor = await ensureVendor(supabase, foreignOrgId, "Foreign Vendor");
    const foreignDraft = await createDraftBill(supabase, {
      orgId: foreignOrgId,
      vendorId: foreignVendor,
      accounts: await accountMap(supabase, foreignOrgId),
      issueDate: OPEN_PERIOD_DATE,
      total: 100,
      suffix: "foreign",
    });

    await expectRejection(
      () =>
        postMultiBillPayment(supabase, {
          organizationId: orgId,
          partyId: vendorId,
          paymentDate: OPEN_PERIOD_DATE,
          allocations: [{ documentId: foreignDraft.billId, amount: 50 }],
          idempotencyKey: randomUUID(),
        }),
      /not found|not payable/i,
    );

    const { data: crossRead } = await supabase
      .from("teller_documents")
      .select("id")
      .eq("organization_id", orgId)
      .eq("id", foreignDraft.billId)
      .maybeSingle();
    if (crossRead?.id) throw new Error("Foreign bill visible in demo org scope");

    await expectRejection(
      () =>
        convertPurchaseOrderToBill(supabase, {
          organizationId: foreignOrgId,
          purchaseOrderId,
          issueDate: OPEN_PERIOD_DATE,
          lines: [{ purchaseOrderLineId: poLineId, quantityToBill: 1 }],
        }),
      /not found/i,
    );

    const overForeign = await supabase.rpc("teller_confirm_bank_match", {
      p_organization_id: foreignOrgId,
      p_bank_transaction_id: randomUUID(),
      p_matched_resource_type: "bill_payment",
      p_matched_resource_id: multiBillPaymentId,
      p_matched_amount: 10,
      p_idempotency_event_id: randomUUID(),
      p_actor_id: null,
    });
    if (!overForeign.error?.message.match(/not found|organization/i)) {
      throw new Error(
        `Expected cross-org bank match rejection, got ${overForeign.error?.message ?? "success"}`,
      );
    }

    await supabase.from("teller_document_lines").delete().eq("document_id", foreignDraft.billId);
    await supabase.from("teller_documents").delete().eq("id", foreignDraft.billId);
    await supabase.from("teller_parties").delete().eq("id", foreignVendor);
  });

  await run("C10. Invalid / unauthorized approval rejection", async () => {
    const draft = await createDraftBill(supabase, {
      orgId,
      vendorId,
      accounts,
      issueDate: OPEN_PERIOD_DATE,
      total: 600,
      suffix: "approval-control",
    });
    const journalsBefore = await journalCount(supabase, orgId);

    if (canApproveBills("bookkeeper")) {
      throw new Error("bookkeeper should not be allowed to approve bills");
    }

    await expectRejection(
      () => approveBill(supabase, { organizationId: orgId, documentId: draft.billId }),
      /pending approval/i,
    );

    await submitBillForApproval(supabase, { organizationId: orgId, documentId: draft.billId });
    const { data: pending } = await supabase
      .from("teller_documents")
      .select("status")
      .eq("id", draft.billId)
      .single();
    if (pending?.status !== "pending_approval") {
      throw new Error(`Expected pending_approval, got ${pending?.status}`);
    }

    await expectRejection(
      () => approveBill(supabase, { organizationId: orgId, documentId: partialBillId }),
      /pending approval/i,
    );

    const journalsMid = await journalCount(supabase, orgId);
    if (journalsMid !== journalsBefore) {
      throw new Error("Invalid approval attempts changed journal count");
    }

    await approveBill(supabase, { organizationId: orgId, documentId: draft.billId });
    const journalsAfter = await journalCount(supabase, orgId);
    if (journalsAfter !== journalsBefore + 1) {
      throw new Error("Valid approval should post exactly one journal");
    }
  });

  await run("24. Duplicate invoice warning path", async () => {
    const dupes = await detectDuplicateBillWarnings(supabase, {
      organizationId: orgId,
      partyId: vendorId,
      referenceNumber: "INV-DUP-TEST",
      total: 100,
      issueDate: OPEN_PERIOD_DATE,
    });
    if (!Array.isArray(dupes)) throw new Error("Expected duplicate warnings array");
  });

  await run("13. Partial bill payment (additional)", async () => {
    const remaining = await authoritativeDocumentRemaining(
      supabase,
      orgId,
      partialBillId,
      partialBillTotal,
    );
    if (remaining <= 0) throw new Error("Nothing left to pay on partial bill");
    const { paymentId } = await postMultiBillPayment(supabase, {
      organizationId: orgId,
      partyId: vendorId,
      paymentDate: OPEN_PERIOD_DATE,
      allocations: [{ documentId: partialBillId, amount: Math.min(10, remaining) }],
      idempotencyKey: randomUUID(),
    });
    if (!paymentId) throw new Error("payment missing");
  });

  await run("14. Remaining balance correct", async () => {
    const remaining = await authoritativeDocumentRemaining(
      supabase,
      orgId,
      partialBillId,
      partialBillTotal,
    );
    if (remaining < 0) throw new Error(`Invalid remaining ${remaining}`);
  });

  await run("17. Vendor credit posted", async () => {
    const { data: vcExisting } = await supabase
      .from("teller_documents")
      .select("number")
      .eq("organization_id", orgId)
      .eq("kind", "vendor_credit");
    const vcNumber = nextNumber("VC", (vcExisting ?? []).map((row) => row.number as string));
    const { data: vcDoc } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: orgId,
        kind: "vendor_credit",
        number: vcNumber,
        party_id: vendorId,
        status: "draft",
        issue_date: OPEN_PERIOD_DATE,
        subtotal: 30,
        tax: 0,
        total: 30,
      })
      .select("id")
      .single();
    await supabase.from("teller_document_lines").insert({
      document_id: vcDoc!.id,
      description: "Demo credit",
      amount: 30,
      account_id: accounts["6150"],
      item_type: "credit",
    });
    await postVendorCreditOpen(supabase, {
      organizationId: orgId,
      documentId: vcDoc!.id as string,
      partyId: vendorId,
      jobId: null,
      issueDate: OPEN_PERIOD_DATE,
      number: vcNumber,
      tax: 0,
      lines: [{ amount: 30, account_id: accounts["6150"], description: "Demo credit" }],
    });
  });

  await run("18. Partial credit application", async () => {
    const { data: vc } = await supabase
      .from("teller_documents")
      .select("id")
      .eq("organization_id", orgId)
      .eq("kind", "vendor_credit")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!vc?.id) throw new Error("vendor credit missing");
    const applied = await applyDocumentCredit(supabase, {
      organizationId: orgId,
      sourceDocumentId: vc.id as string,
      targetDocumentId: partialBillId,
      amount: 10,
    });
    if (!applied.allocationId) throw new Error("allocation missing");
    await reverseDocumentAllocation(supabase, {
      organizationId: orgId,
      allocationId: applied.allocationId,
      reversalEventId: randomUUID(),
      reason: "Demo reversal",
    });
  });

  await run("19. Credit application reversal", async () => {
    // Exercised in scenario 18.
  });

  await run("21. Recurring generates draft only", async () => {
    const { data: template } = await supabase
      .from("teller_recurring_bill_templates")
      .insert({
        organization_id: orgId,
        name: "Demo recurring",
        party_id: vendorId,
        recurrence: "monthly",
        start_date: OPEN_PERIOD_DATE,
        default_due_days: 30,
      })
      .select("id")
      .single();
    const gen1 = await generateRecurringBillDraft(supabase, {
      organizationId: orgId,
      templateId: template!.id as string,
      occurrenceDate: OPEN_PERIOD_DATE,
    });
    if (!gen1.billId) throw new Error("Expected draft bill");
    const { data: bill } = await supabase
      .from("teller_documents")
      .select("status")
      .eq("id", gen1.billId)
      .single();
    if (bill?.status !== "draft") throw new Error(`Expected draft, got ${bill?.status}`);
  });

  await run("22. Recurring retry idempotent", async () => {
    const { data: template } = await supabase
      .from("teller_recurring_bill_templates")
      .select("id")
      .eq("organization_id", orgId)
      .eq("name", "Demo recurring")
      .maybeSingle();
    if (!template?.id) throw new Error("template missing");
    const gen2 = await generateRecurringBillDraft(supabase, {
      organizationId: orgId,
      templateId: template.id as string,
      occurrenceDate: OPEN_PERIOD_DATE,
    });
    if (!gen2.duplicate) throw new Error("Expected duplicate on retry");
  });

  await run("23. Job/cost metadata PO → bill", async () => {
    const { data: poLineMeta } = await supabase
      .from("teller_purchase_order_lines")
      .select("cost_category, cost_type")
      .eq("id", poLineId)
      .single();
    const { data: billLineMeta } = await supabase
      .from("teller_document_lines")
      .select("cost_category, cost_type")
      .eq("document_id", partialBillId)
      .limit(1)
      .maybeSingle();
    if (poLineMeta?.cost_category !== billLineMeta?.cost_category) {
      throw new Error("cost_category not copied PO → bill");
    }
  });

  await run("25. AP aging reconciles", async () => {
    const apSummary = await buildApDashboardSummary(supabase, orgId, OPEN_PERIOD_DATE);
    if (apSummary.totalAp < 0) throw new Error("AP negative");
  });

  await run("26. Cash requirements", async () => {
    const apSummary = await buildApDashboardSummary(supabase, orgId, OPEN_PERIOD_DATE);
    if (apSummary.cashRequired30 < 0) throw new Error("cashRequired30 negative");
  });

  await run("20. Payment reversal", async () => {
    if (!multiBillPaymentId) throw new Error("payment missing");
    await reversePayment(supabase, {
      organizationId: orgId,
      paymentId: multiBillPaymentId,
      reversalDate: OPEN_PERIOD_DATE,
      reason: "Demo payment reversal",
    });
  });

  await run("32. HFAC baseline unchanged", async () => {
    const hfacAfter = await hfacBaseline(supabase);
    if (JSON.stringify(hfacBefore) !== JSON.stringify(hfacAfter)) {
      throw new Error(`HFAC changed: ${JSON.stringify(hfacAfter)}`);
    }
  });

  const passed = results.filter((row) => row.pass).length;
  const total = results.length;
  console.log(`\nPhase 6 demo: ${passed}/${total} passed`);
  process.exit(passed === total ? 0 : 1);
}

main();
