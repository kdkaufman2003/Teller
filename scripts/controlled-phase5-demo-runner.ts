/**
 * Phase 5 controlled production demo — dedicated demo org only, never HFAC.
 * Invoked by: npm run demo:phase5:controlled
 */
import { randomUUID } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { postInvoiceOpen, postInvoicePaid } from "../src/lib/accounting/post";
import {
  assertNotHfacOrganization,
  CONTROLLED_PHASE5_DEMO_ORG_NAME,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import { reopenAllPeriodCloses } from "./lib/reopen-demo-period-closes";
import { parseBankCsv } from "../src/lib/banking/csv";
import { importBankTransactionsBatch } from "../src/lib/banking/ingest";
import {
  categorizeBankTransaction,
  confirmBankMatch,
  splitCategorizeBankTransaction,
} from "../src/lib/banking/categorize";
import { createBankTransfer } from "../src/lib/banking/transfer";
import {
  addReconciliationItems,
  computeBookBalanceForBankAccount,
  finalizeBankReconciliation,
  loadReconciliationSummary,
  reopenBankReconciliation,
  startBankReconciliation,
} from "../src/lib/banking/reconciliation";

type ScenarioResult = { name: string; pass: boolean; detail?: string };

const HFAC_ORG_ID = TELLER_HFAC_ORG_ID;

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");
  }
  if (
    process.env.RUN_INTEGRATION_TESTS === "1" ||
    process.env.TELLER_ALLOW_INTEGRATION_DB === "1"
  ) {
    throw new Error("Demo refuses RUN_INTEGRATION_TESTS / TELLER_ALLOW_INTEGRATION_DB");
  }
  const orgId = process.env.TELLER_PHASE5_DEMO_ORG_ID?.trim();
  if (!orgId) {
    throw new Error("TELLER_PHASE5_DEMO_ORG_ID missing — run npm run setup:phase5-demo-org");
  }
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
  const { data, error } = await supabase
    .from("teller_organizations")
    .select("id, name")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.name !== CONTROLLED_PHASE5_DEMO_ORG_NAME) {
    throw new Error(`Expected org "${CONTROLLED_PHASE5_DEMO_ORG_NAME}"`);
  }
  if (data.id === HFAC_ORG_ID) throw new Error("Refusing HFAC org");
}

async function accountMap(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase
    .from("teller_accounts")
    .select("id, code")
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).map((row) => [row.code, row.id as string]));
}

async function hfacBaseline(supabase: SupabaseClient) {
  async function count(table: string) {
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG_ID);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }
  return {
    documents: await count("teller_documents"),
    payments: await count("teller_payments"),
    payment_allocations: await count("teller_payment_allocations"),
    journal_entries: await count("teller_journal_entries"),
  };
}

async function findTxnByDescription(
  supabase: SupabaseClient,
  orgId: string,
  bankAccountId: string,
  needle: string,
) {
  const { data, error } = await supabase
    .from("teller_bank_transactions")
    .select("id, description, normalized_amount, status, posted_date")
    .eq("organization_id", orgId)
    .eq("bank_account_id", bankAccountId)
    .ilike("description", `%${needle}%`)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`Bank transaction not found: ${needle}`);
  return data as {
    id: string;
    description: string;
    normalized_amount: number;
    status: string;
    posted_date: string;
  };
}

async function importCsv(
  supabase: SupabaseClient,
  input: {
    orgId: string;
    bankAccountId: string;
    content: string;
    accountType: string;
    accountSubtype: string;
    importBatchId?: string;
  },
) {
  const parsed = parseBankCsv({
    organizationId: input.orgId,
    bankAccountId: input.bankAccountId,
    content: input.content,
    mapping: { date: "Date", description: "Description", amount: "Amount" },
    bankAccountType: input.accountType,
    bankAccountSubtype: input.accountSubtype,
  });
  if (parsed.errors.length) {
    throw new Error(parsed.errors.map((row) => `row ${row.row}: ${row.message}`).join("; "));
  }
  const result = await importBankTransactionsBatch(supabase, {
    organizationId: input.orgId,
    bankAccountId: input.bankAccountId,
    provider: "manual_csv",
    transactions: parsed.rows,
    importBatchId: input.importBatchId ?? null,
  });
  return { parsed, result };
}

const CHECKING_CSV = `Date,Description,Amount
2026-09-01,Customer payment deposit,-1000.00
2026-09-02,Home Depot materials,87.42
2026-09-03,Split purchase,150.00
2026-09-04,Interest paid,-25.00
2026-09-05,Owner contribution,-5000.00
2026-09-06,Owner draw,1000.00
2026-09-07,Transfer to savings,500.00
2026-09-08,Credit card payment,500.00`;

const CLOSED_PERIOD_CSV = `Date,Description,Amount
2026-09-20,Closed period probe expense,42.00`;

const SAVINGS_CSV = `Date,Description,Amount
2026-09-07,Transfer from checking,-500.00`;

const CREDIT_CARD_CSV = `Date,Description,Amount
2026-09-01,Office supplies charge,125.00
2026-09-08,Card payment received,-500.00`;

async function main() {
  const results: ScenarioResult[] = [];
  const { orgId, supabase } = loadEnv();
  await assertDemoOrg(supabase, orgId);
  const accounts = await accountMap(supabase, orgId);

  const hfacBefore = await hfacBaseline(supabase);

  let checkingBankId = "";
  let savingsBankId = "";
  let creditCardBankId = "";
  let partyId = "";
  let paymentId = "";
  let reconciliationId = "";
  const idempotency = {
    partialMatch1: randomUUID(),
    partialMatch2: randomUUID(),
    expense: randomUUID(),
    split: randomUUID(),
    interest: randomUUID(),
    ownerContribution: randomUUID(),
    ownerDraw: randomUUID(),
    transfer: randomUUID(),
    ccTransfer: randomUUID(),
  };

  async function run(name: string, fn: () => Promise<void>) {
    try {
      assertNotHfacOrganization(orgId);
      await fn();
      results.push({ name, pass: true });
    } catch (error) {
      results.push({
        name,
        pass: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await run("reset: clear prior demo bank activity", async () => {
    await supabase.from("teller_bank_reconciliation_items").delete().eq("organization_id", orgId);
    await supabase.from("teller_bank_reconciliations").delete().eq("organization_id", orgId);
    await supabase.from("teller_bank_matches").delete().eq("organization_id", orgId);
    await supabase.from("teller_bank_transfers").delete().eq("organization_id", orgId);
    await supabase.from("teller_bank_transaction_splits").delete().eq("organization_id", orgId);
    await supabase.from("teller_bank_transactions").delete().eq("organization_id", orgId);
    await reopenAllPeriodCloses(supabase, orgId);
    await supabase.from("teller_payment_allocations").delete().eq("organization_id", orgId);
    await supabase.from("teller_payments").delete().eq("organization_id", orgId);
    await supabase.from("teller_document_journal_links").delete().eq("organization_id", orgId);
    const { data: docs } = await supabase
      .from("teller_documents")
      .select("id")
      .eq("organization_id", orgId);
    const docIds = (docs ?? []).map((row) => row.id);
    if (docIds.length) {
      await supabase.from("teller_document_lines").delete().in("document_id", docIds);
    }
    await supabase.from("teller_documents").delete().eq("organization_id", orgId);
    const { data: entries } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .eq("organization_id", orgId);
    const entryIds = (entries ?? []).map((row) => row.id);
    if (entryIds.length) {
      await supabase.from("teller_journal_lines").delete().in("entry_id", entryIds);
    }
    await supabase.from("teller_journal_entries").delete().eq("organization_id", orgId);
    await supabase.from("teller_parties").delete().eq("organization_id", orgId);
  });

  await run("fixture: resolve demo bank accounts", async () => {
    const { data, error } = await supabase
      .from("teller_bank_accounts")
      .select("id, name, account_type, account_subtype, external_account_id")
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    const byExternal = Object.fromEntries(
      (data ?? []).map((row) => [row.external_account_id as string, row.id as string]),
    );
    checkingBankId = byExternal["demo-checking"];
    savingsBankId = byExternal["demo-savings"];
    creditCardBankId = byExternal["demo-credit-card"];
    if (!checkingBankId || !savingsBankId || !creditCardBankId) {
      throw new Error("Demo bank accounts missing — run setup:phase5-demo-org");
    }
  });

  await run("fixture: create demo customer", async () => {
    const { data, error } = await supabase
      .from("teller_parties")
      .insert({
        organization_id: orgId,
        kind: "customer",
        name: "Phase 5 Demo Customer",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message || "party");
    partyId = data.id as string;
  });

  await run("fixture: post invoice payment for matching ($1000)", async () => {
    const { data: doc, error } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: orgId,
        kind: "invoice",
        number: `P5-DEMO-${Date.now()}`,
        status: "draft",
        issue_date: "2026-09-01",
        total: 1000,
        subtotal: 1000,
        tax: 0,
        party_id: partyId,
      })
      .select("id, number")
      .single();
    if (error || !doc) throw new Error(error?.message || "invoice");

    await postInvoiceOpen(supabase, {
      organizationId: orgId,
      documentId: doc.id,
      partyId,
      jobId: null,
      issueDate: "2026-09-01",
      number: doc.number,
      tax: 0,
      lines: [{ amount: 1000, account_id: accounts["4000"], description: "Demo service" }],
    });

    const paid = await postInvoicePaid(supabase, {
      organizationId: orgId,
      documentId: doc.id,
      partyId,
      jobId: null,
      issueDate: "2026-09-01",
      number: doc.number,
      total: 1000,
      invoiceTotal: 1000,
      priorPaid: 0,
    });
    if (!paid.paymentId) throw new Error("Missing payment id");
    paymentId = paid.paymentId;
  });

  await run("CSV import: checking transactions (first import)", async () => {
    const { result, parsed } = await importCsv(supabase, {
      orgId,
      bankAccountId: checkingBankId,
      content: CHECKING_CSV,
      accountType: "depository",
      accountSubtype: "checking",
    });
    if (result.imported + result.updated < parsed.rows.length) {
      throw new Error(`Expected imports, got ${JSON.stringify(result)}`);
    }
  });

  await run("CSV import: re-import same CSV (idempotent upsert)", async () => {
    const beforeCount = await supabase
      .from("teller_bank_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("bank_account_id", checkingBankId);
    const countBefore = beforeCount.count ?? 0;

    const { result } = await importCsv(supabase, {
      orgId,
      bankAccountId: checkingBankId,
      content: CHECKING_CSV,
      accountType: "depository",
      accountSubtype: "checking",
    });

    const afterCount = await supabase
      .from("teller_bank_transactions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("bank_account_id", checkingBankId);

    if ((afterCount.count ?? 0) !== countBefore) {
      throw new Error("Re-import changed row count");
    }
    if (result.imported > 0) {
      throw new Error(`Re-import created new rows: ${JSON.stringify(result)}`);
    }
    if (result.updated === 0 && result.duplicates === 0) {
      throw new Error(`Expected updates on re-import: ${JSON.stringify(result)}`);
    }
  });

  await run("match: partial multi-match on $1000 payment (700 + 300)", async () => {
    const txn = await findTxnByDescription(supabase, orgId, checkingBankId, "Customer payment");

    const first = await confirmBankMatch(supabase, {
      organizationId: orgId,
      bankTransactionId: txn.id,
      matchedResourceType: "customer_payment",
      matchedResourceId: paymentId,
      matchedAmount: 700,
      idempotencyEventId: idempotency.partialMatch1,
    });
    if (first.duplicate) throw new Error("First partial match marked duplicate");

    const { data: mid } = await supabase
      .from("teller_bank_transactions")
      .select("status")
      .eq("id", txn.id)
      .single();
    if (mid?.status !== "partially_matched") {
      throw new Error(`Expected partially_matched, got ${mid?.status}`);
    }

    const retryFirst = await confirmBankMatch(supabase, {
      organizationId: orgId,
      bankTransactionId: txn.id,
      matchedResourceType: "customer_payment",
      matchedResourceId: paymentId,
      matchedAmount: 700,
      idempotencyEventId: idempotency.partialMatch1,
    });
    if (!retryFirst.duplicate) throw new Error("Idempotent retry should be duplicate");

    const second = await confirmBankMatch(supabase, {
      organizationId: orgId,
      bankTransactionId: txn.id,
      matchedResourceType: "customer_payment",
      matchedResourceId: paymentId,
      matchedAmount: 300,
      idempotencyEventId: idempotency.partialMatch2,
    });
    if (second.duplicate) throw new Error("Second partial match marked duplicate");

    const over = await supabase.rpc("teller_confirm_bank_match", {
      p_organization_id: orgId,
      p_bank_transaction_id: txn.id,
      p_matched_resource_type: "customer_payment",
      p_matched_resource_id: paymentId,
      p_matched_amount: 1,
      p_idempotency_event_id: randomUUID(),
      p_actor_id: null,
    });
    if (!over.error?.message.includes("exceed")) {
      throw new Error(`Expected overmatch rejection, got ${over.error?.message ?? "success"}`);
    }
  });

  await run("categorize: normal expense outflow", async () => {
    const txn = await findTxnByDescription(supabase, orgId, checkingBankId, "Home Depot");
    const result = await categorizeBankTransaction(supabase, {
      organizationId: orgId,
      bankTransactionId: txn.id,
      categoryKind: "expense",
      accountId: accounts["6150"],
      memo: "Demo materials expense",
      idempotencyEventId: idempotency.expense,
    });
    if (result.duplicate) throw new Error("Unexpected duplicate on first categorize");
    const retry = await categorizeBankTransaction(supabase, {
      organizationId: orgId,
      bankTransactionId: txn.id,
      categoryKind: "expense",
      accountId: accounts["6150"],
      idempotencyEventId: idempotency.expense,
    });
    if (!retry.duplicate) throw new Error("Idempotent categorize retry should duplicate");
  });

  await run("categorize: split across multiple expense accounts", async () => {
    const txn = await findTxnByDescription(supabase, orgId, checkingBankId, "Split purchase");
    await splitCategorizeBankTransaction(supabase, {
      organizationId: orgId,
      bankTransactionId: txn.id,
      splits: [
        { accountId: accounts["6150"], amount: 100, memo: "Materials portion" },
        { accountId: accounts["6100"], amount: 50, memo: "COGS portion" },
      ],
      idempotencyEventId: idempotency.split,
    });
  });

  await run("categorize: interest deposit", async () => {
    const txn = await findTxnByDescription(supabase, orgId, checkingBankId, "Interest");
    await categorizeBankTransaction(supabase, {
      organizationId: orgId,
      bankTransactionId: txn.id,
      categoryKind: "interest_income",
      accountId: accounts["4100"],
      idempotencyEventId: idempotency.interest,
    });
  });

  await run("categorize: owner contribution", async () => {
    const txn = await findTxnByDescription(supabase, orgId, checkingBankId, "Owner contribution");
    await categorizeBankTransaction(supabase, {
      organizationId: orgId,
      bankTransactionId: txn.id,
      categoryKind: "owner_contribution",
      accountId: accounts["3000"],
      idempotencyEventId: idempotency.ownerContribution,
    });
  });

  await run("categorize: owner draw", async () => {
    const txn = await findTxnByDescription(supabase, orgId, checkingBankId, "Owner draw");
    await categorizeBankTransaction(supabase, {
      organizationId: orgId,
      bankTransactionId: txn.id,
      categoryKind: "owner_draw",
      accountId: accounts["3000"],
      idempotencyEventId: idempotency.ownerDraw,
    });
  });

  await run("transfer: checking to savings", async () => {
    await importCsv(supabase, {
      orgId,
      bankAccountId: savingsBankId,
      content: SAVINGS_CSV,
      accountType: "depository",
      accountSubtype: "savings",
    });
    const outTxn = await findTxnByDescription(supabase, orgId, checkingBankId, "Transfer to savings");
    const inTxn = await findTxnByDescription(supabase, orgId, savingsBankId, "Transfer from checking");
    await createBankTransfer(supabase, {
      organizationId: orgId,
      sourceBankTransactionId: outTxn.id,
      destinationBankTransactionId: inTxn.id,
      amount: 500,
      transferDate: "2026-09-07",
      idempotencyEventId: idempotency.transfer,
    });
  });

  await run("transfer: checking to credit card (no expense)", async () => {
    await importCsv(supabase, {
      orgId,
      bankAccountId: creditCardBankId,
      content: CREDIT_CARD_CSV,
      accountType: "credit",
      accountSubtype: "credit card",
    });
    const checkingOut = await findTxnByDescription(
      supabase,
      orgId,
      checkingBankId,
      "Credit card payment",
    );
    const cardPayment = await findTxnByDescription(
      supabase,
      orgId,
      creditCardBankId,
      "Card payment",
    );

    const ccExpenseAttempt = await supabase.rpc("teller_categorize_bank_transaction", {
      p_organization_id: orgId,
      p_bank_transaction_id: cardPayment.id,
      p_category_kind: "expense",
      p_account_id: accounts["6150"],
      p_party_id: null,
      p_job_id: null,
      p_memo: "Should fail",
      p_idempotency_event_id: randomUUID(),
      p_actor_id: null,
    });
    if (!ccExpenseAttempt.error?.message.includes("Credit card payments must be matched")) {
      throw new Error(
        `Expected CC payment categorize rejection, got ${ccExpenseAttempt.error?.message ?? "success"}`,
      );
    }

    const transfer = await createBankTransfer(supabase, {
      organizationId: orgId,
      sourceBankTransactionId: checkingOut.id,
      destinationBankTransactionId: cardPayment.id,
      amount: 500,
      transferDate: "2026-09-08",
      idempotencyEventId: idempotency.ccTransfer,
    });

    if (!transfer.journalEntryId) throw new Error("Missing transfer journal");
    const { data: lines, error } = await supabase
      .from("teller_journal_lines")
      .select("account_id, debit, credit")
      .eq("entry_id", transfer.journalEntryId);
    if (error) throw new Error(error.message);

    const expenseHit = (lines ?? []).some(
      (line) => line.account_id === accounts["6150"] || line.account_id === accounts["6100"],
    );
    if (expenseHit) throw new Error("Credit card payment transfer created expense lines");

    const hasChecking = (lines ?? []).some((line) => line.account_id === accounts["1000"]);
    const hasLiability = (lines ?? []).some((line) => line.account_id === accounts["2100"]);
    if (!hasChecking || !hasLiability) {
      throw new Error("Transfer journal missing checking/credit-card GL lines");
    }
  });

  await run("reconciliation: first close with $0 difference", async () => {
    const { data: txns, error: txnsError } = await supabase
      .from("teller_bank_transactions")
      .select("id, posted_date, normalized_amount, status")
      .eq("organization_id", orgId)
      .eq("bank_account_id", checkingBankId)
      .not("status", "eq", "excluded");
    if (txnsError) throw new Error(txnsError.message);

    const netCleared = (txns ?? []).reduce(
      (sum, txn) => sum + Number(txn.normalized_amount),
      0,
    );
    const bookBalance = await computeBookBalanceForBankAccount(supabase, orgId, checkingBankId);
    if (Math.abs(netCleared - bookBalance) > 0.01) {
      throw new Error(`Book balance ${bookBalance} != bank net ${netCleared} before reconciliation`);
    }

    const { reconciliationId: reconId } = await startBankReconciliation(supabase, {
      organizationId: orgId,
      bankAccountId: checkingBankId,
      statementStartDate: "2026-09-01",
      statementEndDate: "2026-09-30",
      statementEndingBalance: netCleared,
      beginningReconciledBalance: 0,
    });
    reconciliationId = reconId;

    await addReconciliationItems(supabase, {
      organizationId: orgId,
      reconciliationId: reconId,
      items: (txns ?? [])
        .filter((txn) => Math.abs(Number(txn.normalized_amount)) > 0.009)
        .map((txn) => ({
          bankTransactionId: txn.id,
          clearedAmount: Math.abs(Number(txn.normalized_amount)),
          clearedDate: txn.posted_date,
        })),
    });

    const summary = await loadReconciliationSummary(supabase, orgId, reconId);
    if (Math.abs(summary.difference) > 0.01) {
      throw new Error(
        `Difference ${summary.difference} (net ${netCleared}, ending ${summary.statementEndingBalance})`,
      );
    }

    await finalizeBankReconciliation(supabase, {
      organizationId: orgId,
      reconciliationId: reconId,
    });

    const { data: recon } = await supabase
      .from("teller_bank_reconciliations")
      .select("status")
      .eq("id", reconId)
      .single();
    if (recon?.status !== "completed") throw new Error(`Expected completed, got ${recon?.status}`);
  });

  await run("reconciliation: reopen with reason and audit trail", async () => {
    if (!reconciliationId) throw new Error("Missing reconciliation id");
    await reopenBankReconciliation(supabase, {
      organizationId: orgId,
      reconciliationId,
      reason: "Demo reopen verification",
    });

    const { data: audits, error } = await supabase
      .from("teller_audit_events")
      .select("action, metadata")
      .eq("organization_id", orgId)
      .eq("resource_kind", "bank_reconciliation")
      .eq("resource_id", reconciliationId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);

    const actions = (audits ?? []).map((row) => row.action);
    const hasReopen =
      actions.includes("banking.reconciliation.reopened") ||
      actions.includes("bank_reconciliation.reopened");
    if (!hasReopen) {
      throw new Error(`Missing reopen audit, saw: ${actions.join(", ")}`);
    }
  });

  await run("period lock: reject categorize in closed period", async () => {
    await importCsv(supabase, {
      orgId,
      bankAccountId: checkingBankId,
      content: CLOSED_PERIOD_CSV,
      accountType: "depository",
      accountSubtype: "checking",
    });

    await supabase.from("teller_period_closes").insert({
      organization_id: orgId,
      period_end: "2026-09-30",
      notes: "Phase 5 demo close",
    });

    const txn = await findTxnByDescription(
      supabase,
      orgId,
      checkingBankId,
      "Closed period probe",
    );
    const closed = await supabase.rpc("teller_categorize_bank_transaction", {
      p_organization_id: orgId,
      p_bank_transaction_id: txn.id,
      p_category_kind: "expense",
      p_account_id: accounts["6150"],
      p_party_id: null,
      p_job_id: null,
      p_memo: "Should fail closed period",
      p_idempotency_event_id: randomUUID(),
      p_actor_id: null,
    });
    if (!closed.error?.message.toLowerCase().includes("closed")) {
      throw new Error(`Expected closed period rejection, got ${closed.error?.message ?? "success"}`);
    }
  });

  await run("HFAC baseline unchanged after demo", async () => {
    const hfacAfter = await hfacBaseline(supabase);
    for (const key of Object.keys(hfacBefore) as Array<keyof typeof hfacBefore>) {
      if (hfacAfter[key] !== hfacBefore[key]) {
        throw new Error(`${key}: before ${hfacBefore[key]} after ${hfacAfter[key]}`);
      }
    }
  });

  const passed = results.filter((row) => row.pass).length;
  const failed = results.filter((row) => !row.pass);

  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        organizationId: orgId,
        organizationName: CONTROLLED_PHASE5_DEMO_ORG_NAME,
        hfacBefore,
        passed,
        failed: failed.length,
        results,
      },
      null,
      2,
    ),
  );

  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
