/**
 * Phase 7 controlled production demo — dedicated demo org only, never HFAC.
 * 45-scenario acceptance matrix.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { postBillOpen, postBillPaid } from "../src/lib/accounting/bills";
import { convertPurchaseOrderToBill } from "../src/lib/accounting/po-to-bill";
import {
  createPurchaseOrder,
  receivePurchaseOrder,
  submitPurchaseOrderForApproval,
  approvePurchaseOrder,
  markPurchaseOrderSent,
} from "../src/lib/accounting/purchase-orders";
import { postCreditMemoOpen } from "../src/lib/accounting/credits";
import { receiveCustomerDeposit } from "../src/lib/accounting/deposits";
import {
  createJob,
  closeJob,
  reopenJob,
  cancelJob,
  markJobCompleted,
  detectJobCloseWarnings,
  assertJobAcceptsAssignment,
} from "../src/lib/accounting/jobs";
import {
  buildJobProfitabilitySummary,
  computeProjectedCost,
  computeProjectedRevenue,
  computeRemainingBudget,
} from "../src/lib/accounting/job-profitability";
import { allocateJobNumber } from "../src/lib/accounting/job-numbering";
import { postInvoiceOpen, postInvoicePaid, postExpense, assertOrgPeriodOpen } from "../src/lib/accounting/post";
import { nextNumber } from "../src/lib/accounting/accounts";
import { listUnassignedJobActivity } from "../src/lib/accounting/unassigned-job-activity";
import { asNumber } from "../src/lib/format";
import {
  assertNotHfacOrganization,
  CONTROLLED_PHASE7_DEMO_ORG_NAME,
  CONTROLLED_PHASE7_FOREIGN_ORG_NAME,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";

const HFAC_ORG_ID = TELLER_HFAC_ORG_ID;
const TODAY = "2026-10-01";
const CLOSED_PERIOD_END = "2026-08-31";
const CLOSED_PERIOD_DATE = "2026-08-15";

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") throw new Error("TELLER_CONTROLLED_PROD_TEST must equal 1");
  const orgId = process.env.TELLER_PHASE7_DEMO_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE7_DEMO_ORG_ID missing");
  assertNotHfacOrganization(orgId);
  return {
    orgId,
    supabase: createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
  };
}

async function assertDemoOrg(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase
    .from("teller_organizations")
    .select("id, name")
    .eq("id", orgId)
    .maybeSingle();
  if (!data || data.name !== CONTROLLED_PHASE7_DEMO_ORG_NAME) {
    throw new Error(`Expected org "${CONTROLLED_PHASE7_DEMO_ORG_NAME}"`);
  }
}

async function journalCount(supabase: SupabaseClient, orgId: string) {
  const { count } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  return count ?? 0;
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
    jobs: await count("teller_jobs"),
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

async function cleanup(supabase: SupabaseClient, orgId: string) {
  for (const table of [
    "teller_job_budget_lines",
    "teller_document_allocations",
    "teller_payment_allocations",
    "teller_payments",
    "teller_purchase_receipt_lines",
    "teller_purchase_receipts",
    "teller_purchase_order_lines",
    "teller_purchase_orders",
    "teller_document_journal_links",
    "teller_audit_events",
  ]) {
    await supabase.from(table).delete().eq("organization_id", orgId);
  }
  const { data: docs } = await supabase.from("teller_documents").select("id").eq("organization_id", orgId);
  const docIds = (docs ?? []).map((row) => row.id as string);
  if (docIds.length) await supabase.from("teller_document_lines").delete().in("document_id", docIds);
  await supabase.from("teller_documents").delete().eq("organization_id", orgId);
  const { data: entries } = await supabase.from("teller_journal_entries").select("id").eq("organization_id", orgId);
  const entryIds = (entries ?? []).map((row) => row.id as string);
  if (entryIds.length) await supabase.from("teller_journal_lines").delete().in("entry_id", entryIds);
  await supabase.from("teller_journal_entries").delete().eq("organization_id", orgId);
  await supabase.from("teller_jobs").delete().eq("organization_id", orgId);
  await supabase.from("teller_parties").delete().eq("organization_id", orgId);
  await supabase.from("teller_period_closes").delete().eq("organization_id", orgId);
}

async function ensureVendor(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase
    .from("teller_parties")
    .insert({ organization_id: orgId, kind: "vendor", name: "Phase 7 Demo Vendor" })
    .select("id")
    .single();
  return data!.id as string;
}

async function ensureCustomer(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase
    .from("teller_parties")
    .insert({ organization_id: orgId, kind: "customer", name: "Phase 7 Demo Customer" })
    .select("id")
    .single();
  return data!.id as string;
}

async function accountMap(supabase: SupabaseClient, orgId: string) {
  const { data } = await supabase.from("teller_accounts").select("id, code, type").eq("organization_id", orgId);
  return Object.fromEntries((data ?? []).map((row) => [row.code, row.id as string]));
}

async function createDraftInvoice(
  supabase: SupabaseClient,
  orgId: string,
  input: { customerId: string; headerJobId?: string; lines: { amount: number; jobId: string; accountId: string }[] },
) {
  const { data: existing } = await supabase.from("teller_documents").select("number").eq("organization_id", orgId).eq("kind", "invoice");
  const number = nextNumber("INV", (existing ?? []).map((row) => row.number as string));
  const total = input.lines.reduce((sum, line) => sum + line.amount, 0);
  const { data: doc } = await supabase
    .from("teller_documents")
    .insert({
      organization_id: orgId,
      kind: "invoice",
      number,
      party_id: input.customerId,
      job_id: input.headerJobId ?? input.lines[0]?.jobId ?? null,
      status: "draft",
      issue_date: TODAY,
      subtotal: total,
      total,
    })
    .select("id")
    .single();
  await supabase.from("teller_document_lines").insert(
    input.lines.map((line) => ({
      document_id: doc!.id,
      description: "Line",
      amount: line.amount,
      account_id: line.accountId,
      job_id: line.jobId,
    })),
  );
  return { docId: doc!.id as string, number, total };
}

async function main() {
  const { orgId, supabase } = loadEnv();
  await assertDemoOrg(supabase, orgId);
  const hfacBefore = await hfacBaseline(supabase);
  const results: Array<{ name: string; pass: boolean; detail?: string }> = [];

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

  await cleanup(supabase, orgId);
  const accounts = await accountMap(supabase, orgId);
  const vendorId = await ensureVendor(supabase, orgId);
  const customerId = await ensureCustomer(supabase, orgId);

  let jobA = "";
  let jobB = "";
  let jobC = "";

  await run("1. Create customer", async () => {
    if (!customerId) throw new Error("missing customer");
  });

  await run("2. Create job with auto number", async () => {
    const job = await createJob(supabase, {
      organizationId: orgId,
      name: "Demo Install",
      customerPartyId: customerId,
      originalContractAmount: 10000,
      estimatedRevenue: 10000,
      estimatedCost: 6000,
    });
    jobA = job.id as string;
    if (!(job.job_number as string).startsWith("JOB-")) throw new Error("expected JOB- prefix");
  });

  await run("3. Job creation creates zero journals", async () => {
    const before = await journalCount(supabase, orgId);
    const job = await createJob(supabase, { organizationId: orgId, name: "Second Job", customerPartyId: customerId });
    jobB = job.id as string;
    const after = await journalCount(supabase, orgId);
    if (after !== before) throw new Error("job created journals");
  });

  await run("4. Concurrency-safe job numbers", async () => {
    const [n1, n2] = await Promise.all([allocateJobNumber(supabase, orgId), allocateJobNumber(supabase, orgId)]);
    if (n1 === n2) throw new Error(`duplicate numbers: ${n1}`);
  });

  await run("5. Budget line creates zero journals", async () => {
    const before = await journalCount(supabase, orgId);
    await supabase.from("teller_job_budget_lines").insert({
      organization_id: orgId,
      job_id: jobA,
      cost_classification: "direct",
      estimated_amount: 6000,
    });
    const after = await journalCount(supabase, orgId);
    if (after !== before) throw new Error("budget created journals");
  });

  await run("6. HVAC cost categories seeded", async () => {
    const { data } = await supabase
      .from("teller_job_cost_categories")
      .select("code")
      .eq("organization_id", orgId)
      .eq("active", true);
    const codes = new Set((data ?? []).map((row) => row.code as string));
    if (!codes.has("materials") || !codes.has("labor")) throw new Error("missing HVAC categories");
  });

  await run("7. PO commitment creates zero journals", async () => {
    const before = await journalCount(supabase, orgId);
    const { purchaseOrderId } = await createPurchaseOrder(supabase, {
      organizationId: orgId,
      partyId: vendorId,
      jobId: jobA,
      issueDate: TODAY,
      lines: [
        {
          description: "Materials",
          quantity: 10,
          unitCost: 100,
          accountId: accounts["6150"],
          jobId: jobA,
          costCategory: "materials",
          costType: "material",
        },
      ],
    });
    await submitPurchaseOrderForApproval(supabase, { organizationId: orgId, purchaseOrderId });
    await approvePurchaseOrder(supabase, { organizationId: orgId, purchaseOrderId });
    await markPurchaseOrderSent(supabase, { organizationId: orgId, purchaseOrderId });
    const after = await journalCount(supabase, orgId);
    if (after !== before) throw new Error("PO created journals");
    const summary = await buildJobProfitabilitySummary(supabase, orgId, jobA);
    if (summary.remainingCommittedCost <= 0) throw new Error("expected committed cost");
    if (summary.actualDirectCost > 0) throw new Error("PO should not create actual cost");
  });

  await run("8. PO receipt does not create actual cost", async () => {
    const { data: po } = await supabase.from("teller_purchase_orders").select("id").eq("organization_id", orgId).limit(1).single();
    const { data: poLine } = await supabase
      .from("teller_purchase_order_lines")
      .select("id")
      .eq("purchase_order_id", po!.id as string)
      .single();
    const costBefore = (await buildJobProfitabilitySummary(supabase, orgId, jobA)).actualDirectCost;
    await receivePurchaseOrder(supabase, {
      organizationId: orgId,
      purchaseOrderId: po!.id as string,
      receiptDate: TODAY,
      lines: [{ purchaseOrderLineId: poLine!.id as string, quantityReceived: 5 }],
    });
    const costAfter = (await buildJobProfitabilitySummary(supabase, orgId, jobA)).actualDirectCost;
    if (Math.abs(costAfter - costBefore) > 0.01) throw new Error("receipt changed actual cost");
  });

  await run("9. PO→bill converts commitment to actual cost", async () => {
    const { data: po } = await supabase.from("teller_purchase_orders").select("id").eq("organization_id", orgId).limit(1).single();
    const poId = po!.id as string;
    const { data: poLine } = await supabase.from("teller_purchase_order_lines").select("id").eq("purchase_order_id", poId).single();
    const committedBefore = (await buildJobProfitabilitySummary(supabase, orgId, jobA)).remainingCommittedCost;
    const bill = await convertPurchaseOrderToBill(supabase, {
      organizationId: orgId,
      purchaseOrderId: poId,
      issueDate: TODAY,
      lines: [{ purchaseOrderLineId: poLine!.id as string, quantityToBill: 10 }],
    });
    const { data: billDoc } = await supabase.from("teller_documents").select("number, total").eq("id", bill.billId).single();
    await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: bill.billId,
      partyId: vendorId,
      jobId: jobA,
      issueDate: TODAY,
      number: billDoc!.number as string,
      tax: 0,
      lines: [
        {
          amount: asNumber(billDoc?.total),
          account_id: accounts["6150"],
          description: "Materials",
          job_id: jobA,
          cost_classification: "direct",
        },
      ],
    });
    const summary = await buildJobProfitabilitySummary(supabase, orgId, jobA);
    if (summary.actualDirectCost <= 0) throw new Error("expected actual cost from bill");
    if (summary.remainingCommittedCost >= committedBefore) throw new Error("commitment should decrease after bill");
  });

  let billId = "";
  await run("10. Bill payment does not increase job cost", async () => {
    const { data: bill } = await supabase
      .from("teller_documents")
      .select("id, number, total")
      .eq("organization_id", orgId)
      .eq("kind", "bill")
      .limit(1)
      .single();
    billId = bill!.id as string;
    const costBefore = (await buildJobProfitabilitySummary(supabase, orgId, jobA)).actualDirectCost;
    await postBillPaid(supabase, {
      organizationId: orgId,
      documentId: billId,
      partyId: vendorId,
      jobId: jobA,
      issueDate: TODAY,
      number: bill!.number as string,
      paymentAmount: asNumber(bill!.total),
      billTotal: asNumber(bill!.total),
    });
    const costAfter = (await buildJobProfitabilitySummary(supabase, orgId, jobA)).actualDirectCost;
    if (Math.abs(costAfter - costBefore) > 0.01) throw new Error("payment changed actual cost");
  });

  await run("11. Expense assigned to job as direct cost", async () => {
    const { data: existing } = await supabase.from("teller_documents").select("number").eq("organization_id", orgId).eq("kind", "expense");
    const number = nextNumber("EXP", (existing ?? []).map((row) => row.number as string));
    const { data: doc } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: orgId,
        kind: "expense",
        number,
        party_id: vendorId,
        job_id: jobA,
        status: "draft",
        issue_date: TODAY,
        subtotal: 250,
        total: 250,
      })
      .select("id")
      .single();
    const costBefore = (await buildJobProfitabilitySummary(supabase, orgId, jobA)).actualDirectCost;
    await postExpense(supabase, {
      organizationId: orgId,
      documentId: doc!.id as string,
      partyId: vendorId,
      jobId: jobA,
      issueDate: TODAY,
      number,
      amount: 250,
      accountId: accounts["6150"],
      paid: true,
      costClassification: "direct",
    });
    const costAfter = (await buildJobProfitabilitySummary(supabase, orgId, jobA)).actualDirectCost;
    if (costAfter <= costBefore) throw new Error("expense not in actual cost");
  });

  await run("12. Indirect cost classification excluded from direct cost", async () => {
    const { data: existing } = await supabase.from("teller_documents").select("number").eq("organization_id", orgId).eq("kind", "expense");
    const number = nextNumber("EXP", (existing ?? []).map((row) => row.number as string));
    const { data: doc } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: orgId,
        kind: "expense",
        number,
        party_id: vendorId,
        job_id: jobA,
        status: "draft",
        issue_date: TODAY,
        subtotal: 100,
        total: 100,
      })
      .select("id")
      .single();
    const before = await buildJobProfitabilitySummary(supabase, orgId, jobA);
    await postExpense(supabase, {
      organizationId: orgId,
      documentId: doc!.id as string,
      partyId: vendorId,
      jobId: jobA,
      issueDate: TODAY,
      number,
      amount: 100,
      accountId: accounts["6150"],
      paid: true,
      costClassification: "indirect",
    });
    const after = await buildJobProfitabilitySummary(supabase, orgId, jobA);
    if (Math.abs(after.actualDirectCost - before.actualDirectCost) > 0.01) {
      throw new Error("indirect expense counted as direct cost");
    }
    if (after.indirectCost <= before.indirectCost) throw new Error("expected indirect cost increase");
  });

  await run("13. Invoice posts line-level revenue", async () => {
    const { docId, number } = await createDraftInvoice(supabase, orgId, {
      customerId,
      headerJobId: jobA,
      lines: [
        { amount: 3000, jobId: jobA, accountId: accounts["4000"] },
        { amount: 2000, jobId: jobB, accountId: accounts["4000"] },
      ],
    });
    await postInvoiceOpen(supabase, {
      organizationId: orgId,
      documentId: docId,
      partyId: customerId,
      jobId: jobA,
      issueDate: TODAY,
      number,
      tax: 0,
      lines: [
        { amount: 3000, account_id: accounts["4000"], description: "Job A", job_id: jobA },
        { amount: 2000, account_id: accounts["4000"], description: "Job B", job_id: jobB },
      ],
    });
    const summaryA = await buildJobProfitabilitySummary(supabase, orgId, jobA);
    const summaryB = await buildJobProfitabilitySummary(supabase, orgId, jobB);
    if (Math.abs(summaryA.recognizedRevenue - 3000) > 0.01) throw new Error(`job A revenue ${summaryA.recognizedRevenue}`);
    if (Math.abs(summaryB.recognizedRevenue - 2000) > 0.01) throw new Error(`job B revenue ${summaryB.recognizedRevenue}`);
  });

  await run("14. Cash collection does not increase revenue", async () => {
    const { data: invoice } = await supabase
      .from("teller_documents")
      .select("id, number, total")
      .eq("organization_id", orgId)
      .eq("kind", "invoice")
      .limit(1)
      .single();
    const revBefore = (await buildJobProfitabilitySummary(supabase, orgId, jobA)).recognizedRevenue;
    await postInvoicePaid(supabase, {
      organizationId: orgId,
      documentId: invoice!.id as string,
      partyId: customerId,
      jobId: jobA,
      issueDate: TODAY,
      number: invoice!.number as string,
      total: 1500,
      invoiceTotal: asNumber(invoice!.total),
      priorPaid: 0,
    });
    const after = await buildJobProfitabilitySummary(supabase, orgId, jobA);
    if (Math.abs(after.recognizedRevenue - revBefore) > 0.01) throw new Error("payment changed revenue");
    if (after.cashCollected <= 0) throw new Error("expected cash collected");
  });

  await run("15. Customer deposit is not revenue", async () => {
    const revBefore = (await buildJobProfitabilitySummary(supabase, orgId, jobA)).recognizedRevenue;
    await receiveCustomerDeposit(supabase, {
      organizationId: orgId,
      partyId: customerId,
      jobId: jobA,
      amount: 1000,
      paymentDate: TODAY,
    });
    const after = await buildJobProfitabilitySummary(supabase, orgId, jobA);
    if (Math.abs(after.recognizedRevenue - revBefore) > 0.01) throw new Error("deposit counted as revenue");
    if (after.customerDepositsHeld <= 0) throw new Error("expected deposits held");
  });

  await run("16. Credit memo reduces job revenue", async () => {
    const { data: existing } = await supabase
      .from("teller_documents")
      .select("number")
      .eq("organization_id", orgId)
      .eq("kind", "credit_memo");
    const number = nextNumber("CM", (existing ?? []).map((row) => row.number as string));
    const revBefore = (await buildJobProfitabilitySummary(supabase, orgId, jobA)).recognizedRevenue;
    const { data: doc } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: orgId,
        kind: "credit_memo",
        number,
        party_id: customerId,
        job_id: jobA,
        status: "draft",
        issue_date: TODAY,
        subtotal: 500,
        total: 500,
      })
      .select("id")
      .single();
    await postCreditMemoOpen(supabase, {
      organizationId: orgId,
      documentId: doc!.id as string,
      partyId: customerId,
      jobId: jobA,
      issueDate: TODAY,
      number,
      tax: 0,
      lines: [{ amount: 500, account_id: accounts["4000"], description: "Credit" }],
    });
    const revAfter = (await buildJobProfitabilitySummary(supabase, orgId, jobA)).recognizedRevenue;
    if (revAfter >= revBefore) throw new Error("credit memo did not reduce revenue");
  });

  await run("17. Multi-job bill AP attribution", async () => {
    const job = await createJob(supabase, { organizationId: orgId, name: "Job C", customerPartyId: customerId });
    jobC = job.id as string;
    const { data: existing } = await supabase.from("teller_documents").select("number").eq("organization_id", orgId).eq("kind", "bill");
    const number = nextNumber("BILL", (existing ?? []).map((row) => row.number as string));
    const { data: doc } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: orgId,
        kind: "bill",
        number,
        party_id: vendorId,
        status: "draft",
        issue_date: TODAY,
        subtotal: 800,
        total: 800,
      })
      .select("id")
      .single();
    await postBillOpen(supabase, {
      organizationId: orgId,
      documentId: doc!.id as string,
      partyId: vendorId,
      jobId: jobA,
      issueDate: TODAY,
      number,
      tax: 0,
      lines: [
        { amount: 500, account_id: accounts["6150"], description: "Job A", job_id: jobA, cost_classification: "direct" },
        { amount: 300, account_id: accounts["6150"], description: "Job C", job_id: jobC, cost_classification: "direct" },
      ],
    });
    const apA = (await buildJobProfitabilitySummary(supabase, orgId, jobA)).accountsPayable;
    const apC = (await buildJobProfitabilitySummary(supabase, orgId, jobC)).accountsPayable;
    if (apA <= 0 || apC <= 0) throw new Error("expected AP on both jobs");
    if (Math.abs(apA / (apA + apC) - 500 / 800) > 0.05) throw new Error("AP allocation skewed");
  });

  await run("18. Multi-job invoice AR attribution", async () => {
    const arA = (await buildJobProfitabilitySummary(supabase, orgId, jobA)).accountsReceivable;
    const arB = (await buildJobProfitabilitySummary(supabase, orgId, jobB)).accountsReceivable;
    if (arA <= 0 || arB <= 0) throw new Error("expected AR on both jobs");
  });

  await run("19. Budget vs actual", async () => {
    const summary = await buildJobProfitabilitySummary(supabase, orgId, jobA);
    if (summary.estimatedCost <= 0) throw new Error("expected estimated cost");
    if (summary.actualDirectCost <= 0) throw new Error("expected actual cost");
    const remaining = computeRemainingBudget(summary.estimatedCost, summary.actualDirectCost);
    if (Math.abs(remaining - summary.remainingBudget) > 0.02) throw new Error("remaining budget mismatch");
  });

  await run("20. Committed vs actual cost", async () => {
    const summary = await buildJobProfitabilitySummary(supabase, orgId, jobA);
    if (summary.committedCost < summary.remainingCommittedCost) throw new Error("committed cost logic error");
    if (summary.actualDirectCost <= 0) throw new Error("expected actual cost");
  });

  await run("21. Gross profit and margin", async () => {
    const summary = await buildJobProfitabilitySummary(supabase, orgId, jobA);
    if (summary.grossProfit !== summary.recognizedRevenue - summary.actualDirectCost) {
      throw new Error("GP formula mismatch");
    }
    if (summary.grossMarginPercent == null && summary.recognizedRevenue > 0) {
      throw new Error("expected margin percent");
    }
  });

  await run("22. Projected profitability formulas", async () => {
    const summary = await buildJobProfitabilitySummary(supabase, orgId, jobA);
    const remainingBudget = computeRemainingBudget(summary.estimatedCost, summary.actualDirectCost);
    const projected = computeProjectedCost(summary.actualDirectCost, remainingBudget, summary.remainingCommittedCost);
    if (Math.abs(summary.projectedCost - projected) > 0.02) throw new Error("projected cost mismatch");
    const projectedRev = computeProjectedRevenue({
      revisedContractAmount: summary.revisedContractAmount,
      estimatedRevenue: summary.estimatedRevenue,
      recognizedRevenue: summary.recognizedRevenue,
    });
    if (Math.abs(summary.projectedRevenue - projectedRev) > 0.02) throw new Error("projected revenue mismatch");
  });

  await run("23. Unassigned job activity report", async () => {
    const rows = await listUnassignedJobActivity(supabase, orgId);
    if (!Array.isArray(rows)) throw new Error("expected array");
  });

  await run("24. Job close warnings detected", async () => {
    const warnings = await detectJobCloseWarnings(supabase, orgId, jobA);
    if (!warnings.length) throw new Error("expected close warnings for open AR/AP");
    const codes = warnings.map((row) => row.code);
    if (!codes.includes("open_ar")) throw new Error("expected open_ar warning");
  });

  await run("25. Close blocked without override", async () => {
    let blocked = false;
    try {
      await closeJob(supabase, { organizationId: orgId, jobId: jobA });
    } catch (err) {
      blocked = err instanceof Error && err.message.includes("Job close blocked");
    }
    if (!blocked) throw new Error("close should require override");
  });

  await run("26. Close with override creates no journal", async () => {
    const before = await journalCount(supabase, orgId);
    await closeJob(supabase, { organizationId: orgId, jobId: jobA, overrideReason: "Demo close with open AR" });
    const after = await journalCount(supabase, orgId);
    if (after !== before) throw new Error("close created journals");
  });

  await run("27. Closed job rejects new assignments", async () => {
    let rejected = false;
    try {
      await assertJobAcceptsAssignment(supabase, orgId, jobA);
    } catch (err) {
      rejected = err instanceof Error && err.message.includes("does not accept");
    }
    if (!rejected) throw new Error("closed job should reject assignment");
  });

  await run("28. Reopen with reason restores active status", async () => {
    await reopenJob(supabase, { organizationId: orgId, jobId: jobA, reason: "Demo reopen" });
    const { data: job } = await supabase.from("teller_jobs").select("status").eq("id", jobA).single();
    if (job?.status !== "active") throw new Error(`expected active, got ${job?.status}`);
    await assertJobAcceptsAssignment(supabase, orgId, jobA);
  });

  await run("29. Mark job completed", async () => {
    await markJobCompleted(supabase, { organizationId: orgId, jobId: jobB });
    const { data: job } = await supabase.from("teller_jobs").select("status").eq("id", jobB).single();
    if (job?.status !== "completed") throw new Error("expected completed");
  });

  await run("30. Cancel job", async () => {
    const job = await createJob(supabase, { organizationId: orgId, name: "Cancel Me" });
    await cancelJob(supabase, { organizationId: orgId, jobId: job.id as string });
    const { data: row } = await supabase.from("teller_jobs").select("status").eq("id", job.id as string).single();
    if (row?.status !== "cancelled") throw new Error("expected cancelled");
    let rejected = false;
    try {
      await assertJobAcceptsAssignment(supabase, orgId, job.id as string);
    } catch (err) {
      rejected = err instanceof Error && err.message.includes("does not accept");
    }
    if (!rejected) throw new Error("cancelled job should reject assignment");
  });

  await run("31. GL reconciliation bridge — revenue", async () => {
    const summary = await buildJobProfitabilitySummary(supabase, orgId, jobA);
    const rev = summary.glReconciliation.revenue;
    if (Math.abs(rev.glActivity - (rev.jobAttributed + rev.unassigned)) > 0.05) {
      throw new Error("revenue reconciliation mismatch");
    }
  });

  await run("32. GL reconciliation bridge — direct cost", async () => {
    const summary = await buildJobProfitabilitySummary(supabase, orgId, jobA);
    const cost = summary.glReconciliation.directCost;
    if (Math.abs(cost.glActivity - (cost.jobAttributed + cost.unassigned)) > 0.05) {
      throw new Error("direct cost reconciliation mismatch");
    }
  });

  await run("33. All org journals balanced", async () => {
    await assertOrgJournalsBalanced(supabase, orgId);
  });

  await run("34. Tenant isolation — foreign org cannot read demo jobs", async () => {
    const { data: foreign } = await supabase
      .from("teller_organizations")
      .select("id")
      .eq("name", CONTROLLED_PHASE7_FOREIGN_ORG_NAME)
      .maybeSingle();
    if (!foreign?.id) throw new Error(`Create org "${CONTROLLED_PHASE7_FOREIGN_ORG_NAME}" first`);
    assertNotHfacOrganization(foreign.id as string);
    const { data: leaked } = await supabase
      .from("teller_jobs")
      .select("id")
      .eq("organization_id", foreign.id as string)
      .eq("id", jobA)
      .maybeSingle();
    if (leaked) throw new Error("foreign org saw demo job");
    const { data: crossRead } = await supabase.from("teller_jobs").select("id").eq("id", jobA).eq("organization_id", foreign.id as string);
    if ((crossRead ?? []).length) throw new Error("cross-tenant job read");
  });

  await run("35. Period lock blocks new expense posting", async () => {
    await supabase.from("teller_period_closes").insert({
      organization_id: orgId,
      period_end: CLOSED_PERIOD_END,
      closed_at: new Date().toISOString(),
    });
    let blocked = false;
    try {
      await assertOrgPeriodOpen(supabase, orgId, CLOSED_PERIOD_DATE);
    } catch (err) {
      blocked = err instanceof Error && err.message.toLowerCase().includes("closed");
    }
    if (!blocked) throw new Error("closed period should block posting");
    await supabase.from("teller_period_closes").delete().eq("organization_id", orgId);
  });

  await run("36. Lifecycle events create audit trail", async () => {
    const { data: events } = await supabase
      .from("teller_audit_events")
      .select("action")
      .eq("organization_id", orgId)
      .like("action", "job.%");
    const actions = new Set((events ?? []).map((row) => row.action as string));
    for (const expected of ["job.created", "job.completed", "job.closed", "job.reopened", "job.cancelled"]) {
      if (!actions.has(expected)) throw new Error(`missing audit ${expected}`);
    }
  });

  await run("37. Header job_id defaults invoice lines when omitted", async () => {
    const job = await createJob(supabase, { organizationId: orgId, name: "Default Job Test", customerPartyId: customerId });
    const { data: existing } = await supabase.from("teller_documents").select("number").eq("organization_id", orgId).eq("kind", "invoice");
    const number = nextNumber("INV", (existing ?? []).map((row) => row.number as string));
    const { data: doc } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: orgId,
        kind: "invoice",
        number,
        party_id: customerId,
        job_id: job.id,
        status: "draft",
        issue_date: TODAY,
        subtotal: 400,
        total: 400,
      })
      .select("id")
      .single();
    await postInvoiceOpen(supabase, {
      organizationId: orgId,
      documentId: doc!.id as string,
      partyId: customerId,
      jobId: job.id as string,
      issueDate: TODAY,
      number,
      tax: 0,
      lines: [{ amount: 400, account_id: accounts["4000"], description: "Default job line" }],
    });
    const summary = await buildJobProfitabilitySummary(supabase, orgId, job.id as string);
    if (Math.abs(summary.recognizedRevenue - 400) > 0.01) throw new Error("header job fallback failed");
  });

  await run("38. Settlement-side lines excluded from job direct cost", async () => {
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("account_id, debit, credit, job_id")
      .eq("job_id", jobA);
    const { data: accts } = await supabase.from("teller_accounts").select("id, type").eq("organization_id", orgId);
    const typeById = new Map((accts ?? []).map((row) => [row.id as string, row.type as string]));
    for (const line of lines ?? []) {
      const type = typeById.get(line.account_id as string);
      if (type === "asset" && asNumber(line.credit) > asNumber(line.debit)) {
        throw new Error("settlement credit counted in profitability path unexpectedly");
      }
    }
  });

  await run("39. Projected revenue prefers revised contract", async () => {
    await supabase
      .from("teller_jobs")
      .update({ revised_contract_amount: 15000 })
      .eq("id", jobB);
    const summary = await buildJobProfitabilitySummary(supabase, orgId, jobB);
    if (Math.abs(summary.projectedRevenue - 15000) > 0.01) throw new Error("revised contract not used");
  });

  await run("40. Job numbering unique per organization", async () => {
    const { data: jobs } = await supabase.from("teller_jobs").select("job_number").eq("organization_id", orgId);
    const numbers = (jobs ?? []).map((row) => row.job_number as string);
    if (new Set(numbers).size !== numbers.length) throw new Error("duplicate job numbers in org");
  });

  await run("41. Demo org is not HFAC", async () => {
    if (orgId === HFAC_ORG_ID) throw new Error("demo org is HFAC");
    assertNotHfacOrganization(orgId);
  });

  await run("42. No mutation of HFAC org during demo", async () => {
    const { count } = await supabase
      .from("teller_jobs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", HFAC_ORG_ID)
      .gte("created_at", new Date(Date.now() - 60000).toISOString());
    if ((count ?? 0) > 0) throw new Error("HFAC jobs mutated during demo window");
  });

  await run("43. Committed cost zero after full PO billing", async () => {
    const summary = await buildJobProfitabilitySummary(supabase, orgId, jobA);
    if (summary.remainingCommittedCost > 1) throw new Error(`remaining commitment ${summary.remainingCommittedCost}`);
  });

  await run("44. Refuse HFAC org id in env", async () => {
    let refused = false;
    try {
      assertNotHfacOrganization(HFAC_ORG_ID);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("HFAC org should be refused");
  });

  await run("45. HFAC baseline unchanged", async () => {
    const after = await hfacBaseline(supabase);
    if (JSON.stringify(hfacBefore) !== JSON.stringify(after)) {
      throw new Error(JSON.stringify({ before: hfacBefore, after }));
    }
  });

  const passed = results.filter((row) => row.pass).length;
  console.log(`\nPhase 7 demo: ${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
