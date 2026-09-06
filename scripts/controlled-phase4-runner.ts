/**
 * Controlled Phase 4 production test runner — test org only, never HFAC.
 * Invoked by: npm run test:controlled-prod (requires TELLER_CONTROLLED_PROD_TEST=1)
 */
import { randomUUID } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { authoritativeDocumentRemaining } from "../src/lib/accounting/balances";
import { checkAllocationReversalIntegrity } from "../src/lib/accounting/allocation-integrity";
import {
  assertControlledProdTestEnabled,
  assertControlledTestOrganizationId,
  CONTROLLED_FOREIGN_TEST_ORG_NAME,
  CONTROLLED_TEST_ORG_NAME,
  loadControlledTestOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import {
  applyDepositToInvoice,
  authoritativeDepositRemaining,
  receiveCustomerDeposit,
} from "../src/lib/accounting/deposits";
import {
  applyDocumentCredit,
  postCreditMemoOpen,
} from "../src/lib/accounting/credits";
import { postBillOpen, postBillPaid } from "../src/lib/accounting/bills";
import { postInvoiceOpen, postInvoicePaid } from "../src/lib/accounting/post";
import { reconcileSubledgersToGl } from "../src/lib/accounting/subledger";
import {
  refundCustomerCredit,
  refundCustomerDeposit,
  reverseDepositApplication,
  reverseDocumentAllocation,
  reversePayment,
  writeOffInvoice,
} from "../src/lib/accounting/settlements";
import { TELLER_INTEGRATION_FORCE_ROLLBACK } from "../src/test/integration/helpers";

type ScenarioResult = { name: string; pass: boolean; detail?: string };

function loadEnv() {
  assertControlledProdTestEnabled();
  const testOrgId = process.env.TELLER_CONTROLLED_TEST_ORG_ID?.trim();
  const foreignOrgId = process.env.TELLER_CONTROLLED_FOREIGN_ORG_ID?.trim();
  if (!testOrgId) throw new Error("TELLER_CONTROLLED_TEST_ORG_ID missing");
  return {
    testOrgId,
    foreignOrgId: foreignOrgId ?? null,
    supabase: createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    ),
  };
}

async function accountMap(supabase: SupabaseClient, orgId: string) {
  assertControlledTestOrganizationId(orgId, orgId);
  const { data, error } = await supabase
    .from("teller_accounts")
    .select("id, code")
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).map((row) => [row.code, row.id as string]));
}

async function main() {
  const results: ScenarioResult[] = [];
  const { testOrgId, foreignOrgId, supabase } = loadEnv();

  await loadControlledTestOrganization(supabase, testOrgId);
  if (foreignOrgId) await loadControlledTestOrganization(supabase, foreignOrgId);

  const accounts = await accountMap(supabase, testOrgId);

  async function run(name: string, fn: () => Promise<void>) {
    try {
      assertControlledTestOrganizationId(testOrgId, testOrgId);
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

  await run("schema: Phase 4 RPC teller_reverse_payment exists", async () => {
    const { error } = await supabase.rpc("teller_reverse_payment", {
      p_organization_id: testOrgId,
      p_payment_id: randomUUID(),
      p_reversal_date: "2099-01-01",
      p_reversal_event_id: randomUUID(),
      p_reason: "probe",
    });
    if (error?.message.includes("does not exist")) throw error;
  });

  let partyId = "";
  await run("fixture: create test customer", async () => {
    const { data, error } = await supabase
      .from("teller_parties")
      .insert({
        organization_id: testOrgId,
        kind: "customer",
        name: "Phase4 Test Customer",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message || "party");
    partyId = data.id as string;
  });

  await run("payment reversal", async () => {
    const { data: doc } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: testOrgId,
        kind: "invoice",
        number: `P4-INV-${Date.now()}`,
        status: "draft",
        issue_date: "2026-08-01",
        total: 500,
        subtotal: 500,
        tax: 0,
      })
      .select("id, number")
      .single();
    await postInvoiceOpen(supabase, {
      organizationId: testOrgId,
      documentId: doc!.id,
      partyId,
      jobId: null,
      issueDate: "2026-08-01",
      number: doc!.number,
      tax: 0,
      lines: [{ amount: 500, account_id: accounts["4000"], description: "Svc" }],
    });
    const paid = await postInvoicePaid(supabase, {
      organizationId: testOrgId,
      documentId: doc!.id,
      partyId,
      jobId: null,
      issueDate: "2026-08-02",
      number: doc!.number,
      total: 500,
      invoiceTotal: 500,
      priorPaid: 0,
    });
    await reversePayment(supabase, {
      organizationId: testOrgId,
      paymentId: paid.paymentId!,
      reversalDate: "2026-08-03",
      reversalEventId: randomUUID(),
      reason: "Test reversal",
    });
    expectRemaining(await authoritativeDocumentRemaining(supabase, testOrgId, doc!.id, 500), 500);
  });

  await run("write-off amount_paid cash only", async () => {
    const { data: doc } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: testOrgId,
        kind: "invoice",
        number: `P4-WO-${Date.now()}`,
        status: "draft",
        issue_date: "2026-08-01",
        total: 1000,
        subtotal: 1000,
        tax: 0,
      })
      .select("id, number")
      .single();
    await postInvoiceOpen(supabase, {
      organizationId: testOrgId,
      documentId: doc!.id,
      partyId,
      jobId: null,
      issueDate: "2026-08-01",
      number: doc!.number,
      tax: 0,
      lines: [{ amount: 1000, account_id: accounts["4000"], description: "Svc" }],
    });
    await postInvoicePaid(supabase, {
      organizationId: testOrgId,
      documentId: doc!.id,
      partyId,
      jobId: null,
      issueDate: "2026-08-02",
      number: doc!.number,
      total: 750,
      invoiceTotal: 1000,
      priorPaid: 0,
    });
    await writeOffInvoice(supabase, {
      organizationId: testOrgId,
      invoiceId: doc!.id,
      amount: 250,
      writeoffDate: "2026-08-05",
      writeoffEventId: randomUUID(),
      reason: "Test write-off",
    });
    const { data: updated } = await supabase
      .from("teller_documents")
      .select("amount_paid")
      .eq("id", doc!.id)
      .single();
    if (Number(updated?.amount_paid) !== 750) {
      throw new Error(`amount_paid expected 750 got ${updated?.amount_paid}`);
    }
  });

  await run("credit refund does not increase invoice remaining", async () => {
    const { data: inv } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: testOrgId,
        kind: "invoice",
        number: `P4-CR-${Date.now()}`,
        party_id: partyId,
        status: "draft",
        issue_date: "2026-08-01",
        total: 1000,
        subtotal: 1000,
        tax: 0,
      })
      .select("id, number")
      .single();
    await postInvoiceOpen(supabase, {
      organizationId: testOrgId,
      documentId: inv!.id,
      partyId,
      jobId: null,
      issueDate: "2026-08-01",
      number: inv!.number,
      tax: 0,
      lines: [{ amount: 1000, account_id: accounts["4000"], description: "Svc" }],
    });
    await postInvoicePaid(supabase, {
      organizationId: testOrgId,
      documentId: inv!.id,
      partyId,
      jobId: null,
      issueDate: "2026-08-02",
      number: inv!.number,
      total: 1000,
      invoiceTotal: 1000,
      priorPaid: 0,
    });
    const { data: cm } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: testOrgId,
        kind: "credit_memo",
        number: `P4-CM-${Date.now()}`,
        party_id: partyId,
        status: "draft",
        issue_date: "2026-08-03",
        total: 250,
        subtotal: 250,
        tax: 0,
      })
      .select("id, number")
      .single();
    await postCreditMemoOpen(supabase, {
      organizationId: testOrgId,
      documentId: cm!.id,
      partyId,
      jobId: null,
      issueDate: "2026-08-03",
      number: cm!.number,
      tax: 0,
      lines: [{ amount: 250, account_id: accounts["4000"], description: "Credit" }],
    });
    await refundCustomerCredit(supabase, {
      organizationId: testOrgId,
      creditMemoId: cm!.id,
      amount: 250,
      refundDate: "2026-08-04",
      refundEventId: randomUUID(),
      reason: "Test credit refund",
    });
    const remaining = await authoritativeDocumentRemaining(supabase, testOrgId, inv!.id, 1000);
    if (remaining !== 0) throw new Error(`invoice remaining became ${remaining}`);
  });

  await run("deposit lifecycle", async () => {
    const deposit = await receiveCustomerDeposit(supabase, {
      organizationId: testOrgId,
      partyId,
      amount: 5000,
      paymentDate: "2026-08-01",
    });
    let remaining = await authoritativeDepositRemaining(
      supabase,
      testOrgId,
      deposit.paymentId!,
      5000,
    );
    if (remaining !== 5000) throw new Error(`expected 5000 unapplied got ${remaining}`);

    const { data: inv } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: testOrgId,
        kind: "invoice",
        number: `P4-DEP-${Date.now()}`,
        party_id: partyId,
        status: "open",
        issue_date: "2026-08-01",
        total: 10000,
        subtotal: 10000,
        tax: 0,
      })
      .select("id")
      .single();
    const applied = await applyDepositToInvoice(supabase, {
      organizationId: testOrgId,
      paymentId: deposit.paymentId!,
      invoiceId: inv!.id,
      amount: 3000,
      applicationDate: "2026-08-02",
      applicationEventId: randomUUID(),
    });
    remaining = await authoritativeDepositRemaining(supabase, testOrgId, deposit.paymentId!, 5000);
    if (remaining !== 2000) throw new Error(`after apply expected 2000 got ${remaining}`);

    await refundCustomerDeposit(supabase, {
      organizationId: testOrgId,
      depositPaymentId: deposit.paymentId!,
      amount: 1500,
      refundDate: "2026-08-03",
      refundEventId: randomUUID(),
      reason: "Partial refund",
    });
    remaining = await authoritativeDepositRemaining(supabase, testOrgId, deposit.paymentId!, 5000);
    if (remaining !== 500) throw new Error(`after refund expected 500 got ${remaining}`);

    await reverseDepositApplication(supabase, {
      organizationId: testOrgId,
      allocationId: applied.allocationId,
      reversalDate: "2026-08-04",
      reversalEventId: randomUUID(),
      reason: "Undo apply",
    });
    remaining = await authoritativeDepositRemaining(supabase, testOrgId, deposit.paymentId!, 5000);
    if (remaining !== 3500) throw new Error(`after reversal expected 3500 got ${remaining}`);

    let rejected = false;
    try {
      await refundCustomerDeposit(supabase, {
        organizationId: testOrgId,
        depositPaymentId: deposit.paymentId!,
        amount: 4000,
        refundDate: "2026-08-05",
        refundEventId: randomUUID(),
        reason: "Should fail",
      });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("oversized deposit refund should reject");
  });

  await run("forced rollback sentinel", async () => {
    const { data: cm } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: testOrgId,
        kind: "credit_memo",
        number: `P4-RB-${Date.now()}`,
        party_id: partyId,
        status: "draft",
        issue_date: "2026-08-01",
        total: 100,
        subtotal: 100,
        tax: 0,
      })
      .select("id, number")
      .single();
    await postCreditMemoOpen(supabase, {
      organizationId: testOrgId,
      documentId: cm!.id,
      partyId,
      jobId: null,
      issueDate: "2026-08-01",
      number: cm!.number,
      tax: 0,
      lines: [{ amount: 100, account_id: accounts["4000"], description: "Credit" }],
    });
    const before = await countOrgPayments(supabase, testOrgId);
    try {
      await refundCustomerCredit(supabase, {
        organizationId: testOrgId,
        creditMemoId: cm!.id,
        amount: 50,
        refundDate: "2026-08-02",
        refundEventId: randomUUID(),
        reason: TELLER_INTEGRATION_FORCE_ROLLBACK,
      });
      throw new Error("expected rollback failure");
    } catch (error) {
      if (!(error instanceof Error) || !/FORCE_ROLLBACK/i.test(error.message)) throw error;
    }
    const after = await countOrgPayments(supabase, testOrgId);
    if (after !== before) throw new Error("rollback left orphan payments");
  });

  await run("AR reconciliation", async () => {
    const ar = (await reconcileSubledgersToGl(supabase, testOrgId)).find((r) => r.side === "ar");
    if (!ar?.consistent) throw new Error(`AR mismatch: ${JSON.stringify(ar)}`);
  });

  await run("allocation integrity", async () => {
    const report = await checkAllocationReversalIntegrity(supabase, testOrgId);
    if (!report.consistent) throw new Error(JSON.stringify(report.issues));
  });

  if (foreignOrgId) {
    await run("cross-org deposit refund rejected", async () => {
      const deposit = await receiveCustomerDeposit(supabase, {
        organizationId: testOrgId,
        partyId,
        amount: 200,
        paymentDate: "2026-08-10",
      });
      const foreignAccounts = await accountMap(supabase, foreignOrgId);
      const { error } = await supabase.rpc("teller_refund_customer_deposit", {
        p_organization_id: testOrgId,
        p_deposit_payment_id: deposit.paymentId,
        p_amount: 50,
        p_refund_date: "2026-08-11",
        p_refund_event_id: randomUUID(),
        p_reason: "cross-org cash",
        p_cash_account_id: foreignAccounts["1000"],
        p_deposits_account_id: accounts["2300"],
      });
      if (!error) throw new Error("expected cross-org rejection");
    });
  }

  await run("HFAC org untouched", async () => {
    const { count } = await supabase
      .from("teller_write_offs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", TELLER_HFAC_ORG_ID);
    if ((count ?? 0) > 0) throw new Error("HFAC has write-offs");
  });

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(
    JSON.stringify(
      {
        ok: failed === 0,
        testOrgId,
        foreignOrgId,
        testOrgName: CONTROLLED_TEST_ORG_NAME,
        foreignOrgName: CONTROLLED_FOREIGN_TEST_ORG_NAME,
        passed,
        failed,
        results,
      },
      null,
      2,
    ),
  );
  if (failed > 0) process.exit(1);
}

function expectRemaining(actual: number, expected: number) {
  if (Math.abs(actual - expected) > 0.01) {
    throw new Error(`expected remaining ${expected} got ${actual}`);
  }
}

async function countOrgPayments(supabase: SupabaseClient, orgId: string) {
  const { count, error } = await supabase
    .from("teller_payments")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
