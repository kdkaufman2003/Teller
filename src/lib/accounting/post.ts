import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import {
  authoritativeDocumentAmountPaid,
  checkDocumentBalanceConsistency,
  validateDocumentPayment,
  type DocumentKind,
} from "./balances";
import { recordAuditEvent } from "./audit";
import { accountByCode, accountBySubtype } from "./accounts";
import { documentHasActivePayments } from "./allocations";
import { documentHasAppliedCredits } from "./document-allocations";
import {
  assertInvoiceStatusTransition,
  assertExpenseStatusTransition,
  invoiceStatusAfterPayment,
  type InvoiceStatus,
  type ExpenseStatus,
} from "./document-transitions";
import { recordDocumentJournalLink } from "./journal-links";
import {
  buildInvoicePaymentLines,
  invoicePaymentProgress,
  paymentProcessingFeeAccount,
  resolvePaymentAmounts,
} from "./payment-fees";
import { recordTellerPayment } from "./payments";
import { assertEntryDateOpen } from "./periods";
import { recordTaxSubledgerReversalForDocument } from "./tax/posting/reverse-transactions";

export type JournalLineInput = {
  account_id: string;
  debit?: number;
  credit?: number;
  party_id?: string | null;
  job_id?: string | null;
  job_cost_category_id?: string | null;
  cost_classification?: string | null;
  fixed_asset_id?: string | null;
  memo?: string;
};

export async function resolveLegalEntityId(
  supabase: SupabaseClient,
  organizationId: string,
  legalEntityId?: string | null,
): Promise<string> {
  if (legalEntityId?.trim()) return legalEntityId.trim();
  const { data, error } = await supabase.rpc("teller_default_legal_entity_id", {
    p_org_id: organizationId,
  });
  if (error || !data) {
    throw new Error(error?.message || "Default legal entity missing for organization");
  }
  return data as string;
}

export async function assertOrgPeriodOpen(
  supabase: SupabaseClient,
  organizationId: string,
  entryDate: string,
  legalEntityId?: string | null,
) {
  const entityId = await resolveLegalEntityId(supabase, organizationId, legalEntityId);
  const { data: closedThrough, error } = await supabase.rpc("teller_books_closed_through", {
    p_org: organizationId,
    p_legal_entity_id: entityId,
  });
  if (error) throw new Error(error.message);
  assertEntryDateOpen((closedThrough as string | null) ?? null, entryDate);
}

async function assertDocumentCacheConsistent(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    documentTotal: number;
    cachedAmountPaid: number;
    kind: DocumentKind;
  },
) {
  const result = await checkDocumentBalanceConsistency(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    documentTotal: input.documentTotal,
    cachedAmountPaid: input.cachedAmountPaid,
    kind: input.kind,
  });
  if (!result.consistent) {
    throw new Error(
      `Document payment cache is inconsistent with authoritative records for ${input.documentId}`,
    );
  }
}

export function assertBalanced(lines: JournalLineInput[]) {
  const debit = lines.reduce((sum, line) => sum + asNumber(line.debit), 0);
  const credit = lines.reduce((sum, line) => sum + asNumber(line.credit), 0);
  if (Math.abs(debit - credit) > 0.009) {
    throw new Error(
      `Journal entry is unbalanced: debit ${debit.toFixed(2)} vs credit ${credit.toFixed(2)}`,
    );
  }
}

function journalLinesPayload(lines: JournalLineInput[]) {
  return lines.map((line) => ({
    account_id: line.account_id,
    debit: asNumber(line.debit),
    credit: asNumber(line.credit),
    party_id: line.party_id ?? null,
    job_id: line.job_id ?? null,
    job_cost_category_id: line.job_cost_category_id ?? null,
    cost_classification: line.cost_classification ?? "",
    fixed_asset_id: line.fixed_asset_id ?? null,
    memo: line.memo ?? "",
  }));
}

export async function postJournal(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId?: string | null;
    entryDate: string;
    memo: string;
    sourceKind?: string;
    sourceId?: string;
    reversesEntryId?: string;
    lines: JournalLineInput[];
    actorId?: string | null;
    auditAction?: "journal.posted" | "journal.reversed";
  },
) {
  assertBalanced(input.lines);
  const legalEntityId = await resolveLegalEntityId(
    supabase,
    input.organizationId,
    input.legalEntityId,
  );

  const { data: entryId, error } = await supabase.rpc("teller_post_journal", {
    p_organization_id: input.organizationId,
    p_legal_entity_id: legalEntityId,
    p_entry_date: input.entryDate,
    p_memo: input.memo,
    p_source_kind: input.sourceKind ?? null,
    p_source_id: input.sourceId ?? null,
    p_reverses_entry_id: input.reversesEntryId ?? null,
    p_lines: journalLinesPayload(input.lines),
  });

  if (error || !entryId) {
    throw new Error(error?.message || "Could not create journal entry");
  }

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: input.auditAction ?? "journal.posted",
    resourceKind: "journal_entry",
    resourceId: entryId as string,
    metadata: {
      memo: input.memo,
      sourceKind: input.sourceKind ?? null,
      sourceId: input.sourceId ?? null,
      reversesEntryId: input.reversesEntryId ?? null,
      lineCount: input.lines.length,
    },
  });

  return entryId as string;
}

type JournalLineRow = {
  account_id: string;
  debit: number;
  credit: number;
  party_id: string | null;
  job_id: string | null;
  fixed_asset_id?: string | null;
  memo: string;
};

export function buildReversalLines(lines: JournalLineRow[]): JournalLineInput[] {
  return lines.map((line) => ({
    account_id: line.account_id,
    debit: asNumber(line.credit),
    credit: asNumber(line.debit),
    party_id: line.party_id,
    job_id: line.job_id,
    fixed_asset_id: line.fixed_asset_id ?? null,
    memo: line.memo ? `Reversal: ${line.memo}` : "Reversal",
  }));
}

export async function reverseJournalEntry(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId?: string | null;
    entryId: string;
    entryDate: string;
    memo: string;
    sourceId?: string;
    actorId?: string | null;
  },
) {
  const { data: entry, error: entryError } = await supabase
    .from("teller_journal_entries")
    .select("legal_entity_id")
    .eq("id", input.entryId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (entryError) throw new Error(entryError.message);
  const legalEntityId = await resolveLegalEntityId(
    supabase,
    input.organizationId,
    input.legalEntityId ?? (entry?.legal_entity_id as string | null | undefined),
  );

  await assertOrgPeriodOpen(supabase, input.organizationId, input.entryDate, legalEntityId);
  const { data: lines, error: linesError } = await supabase
    .from("teller_journal_lines")
    .select("account_id, debit, credit, party_id, job_id, fixed_asset_id, memo")
    .eq("entry_id", input.entryId);

  if (linesError) throw new Error(linesError.message);
  if (!lines?.length) throw new Error("Cannot reverse journal entry with no lines");

  const reversedLines = buildReversalLines(lines as JournalLineRow[]);

  return postJournal(supabase, {
    organizationId: input.organizationId,
    legalEntityId,
    entryDate: input.entryDate,
    memo: input.memo,
    sourceKind: "reversal",
    sourceId: input.sourceId,
    reversesEntryId: input.entryId,
    lines: reversedLines,
    actorId: input.actorId,
    auditAction: "journal.reversed",
  });
}

/** Void an invoice by reversing all posted GL entries linked to the document. */
export async function voidInvoice(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    number: string;
    voidDate: string;
    postedEntryId?: string | null;
    currentStatus?: InvoiceStatus;
    actorId?: string | null;
  },
) {
  const hasActivePayments = await documentHasActivePayments(
    supabase,
    input.organizationId,
    input.documentId,
  );
  const hasAppliedCredits = await documentHasAppliedCredits(
    supabase,
    input.organizationId,
    input.documentId,
    false,
  );

  if (hasActivePayments || hasAppliedCredits) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "invoice.void_blocked",
      resourceKind: "invoice",
      resourceId: input.documentId,
      metadata: {
        number: input.number,
        reason: hasActivePayments ? "active_payments" : "applied_credits",
      },
    });
    throw new Error(
      hasActivePayments
        ? "Cannot void an invoice with payment activity. Reverse or refund payments before voiding."
        : "Cannot void an invoice with applied credit memos. Reverse credit applications first.",
    );
  }

  const fromStatus = input.currentStatus ?? "open";
  assertInvoiceStatusTransition(fromStatus, "void", { hasActivePayments: false });

  const { data: linkedEntries, error: entriesError } = await supabase
    .from("teller_journal_entries")
    .select("id, source_kind, created_at")
    .eq("organization_id", input.organizationId)
    .eq("source_id", input.documentId)
    .is("reverses_entry_id", null)
    .neq("source_kind", "reversal")
    .order("created_at", { ascending: false });

  if (entriesError) throw new Error(entriesError.message);

  const entryIds = new Set<string>();
  for (const entry of linkedEntries ?? []) {
    entryIds.add(entry.id as string);
  }
  if (input.postedEntryId) entryIds.add(input.postedEntryId);

  await assertOrgPeriodOpen(supabase, input.organizationId, input.voidDate);

  let taxReversalRecorded = false;
  for (const entryId of entryIds) {
    const { count } = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("reverses_entry_id", entryId);

    if ((count ?? 0) > 0) continue;

    const reversalEntryId = await reverseJournalEntry(supabase, {
      organizationId: input.organizationId,
      entryId,
      entryDate: input.voidDate,
      memo: `Void invoice ${input.number}`,
      sourceId: input.documentId,
      actorId: input.actorId,
    });

    await recordDocumentJournalLink(supabase, {
      organizationId: input.organizationId,
      documentId: input.documentId,
      journalEntryId: reversalEntryId,
      linkKind: "reversal",
    });

    if (!taxReversalRecorded) {
      await recordTaxSubledgerReversalForDocument(supabase, input.organizationId, {
        documentId: input.documentId,
        reversalJournalEntryId: reversalEntryId,
        voidDate: input.voidDate,
        originalTransactionType: "sales_tax_collected",
      });
      taxReversalRecorded = true;
    }
  }

  const { error: docError } = await supabase
    .from("teller_documents")
    .update({
      status: "void",
      amount_paid: 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);

  if (docError) throw new Error(docError.message);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "document.status_changed",
    resourceKind: "invoice",
    resourceId: input.documentId,
    metadata: { number: input.number, from: fromStatus, to: "void" },
  });

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "invoice.voided",
    resourceKind: "invoice",
    resourceId: input.documentId,
    metadata: { number: input.number, reversedEntries: entryIds.size },
  });
}

type AccountRow = {
  id: string;
  code: string;
  type: string;
  subtype: string;
  name: string;
};

export async function loadOrgAccounts(
  supabase: SupabaseClient,
  organizationId: string,
  legalEntityId?: string | null,
): Promise<AccountRow[]> {
  const entityId = await resolveLegalEntityId(supabase, organizationId, legalEntityId);
  const { data, error } = await supabase
    .from("teller_accounts")
    .select("id, code, type, subtype, name")
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", entityId)
    .eq("archived", false);
  if (error) throw new Error(error.message);
  return (data ?? []) as AccountRow[];
}

export async function postInvoiceOpen(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    tax: number;
    taxPayableAccountId?: string | null;
    lines: {
      amount: number;
      account_id: string | null;
      description: string;
      job_id?: string | null;
      cost_classification?: string | null;
    }[];
  },
) {
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const ar = accountBySubtype(accounts, "receivable") || accountByCode(accounts, "1100");
  const taxPayable =
    (input.taxPayableAccountId
      ? accounts.find((account) => account.id === input.taxPayableAccountId)
      : null) ||
    accountBySubtype(accounts, "tax") ||
    accountByCode(accounts, "2100");
  const fallbackRevenue = accounts.find((account) => account.type === "revenue");

  if (!ar) throw new Error("Accounts Receivable is missing from the chart of accounts");

  await assertOrgPeriodOpen(supabase, input.organizationId, input.issueDate);

  const journal: JournalLineInput[] = [];
  const subtotal = input.lines.reduce((sum, line) => sum + asNumber(line.amount), 0);
  const tax = asNumber(input.tax);
  const total = subtotal + tax;

  journal.push({
    account_id: ar.id,
    debit: total,
    party_id: input.partyId,
    job_id: input.jobId,
    memo: `Invoice ${input.number}`,
  });

  for (const line of input.lines) {
    const revenueId = line.account_id || fallbackRevenue?.id;
    if (!revenueId) throw new Error("No revenue account available");
    const lineJobId = line.job_id ?? input.jobId;
    journal.push({
      account_id: revenueId,
      credit: asNumber(line.amount),
      party_id: input.partyId,
      job_id: lineJobId,
      cost_classification: line.cost_classification ?? "",
      memo: line.description,
    });
  }

  if (tax > 0) {
    if (!taxPayable) throw new Error("Sales tax is on this invoice but no tax payable account exists");
    journal.push({
      account_id: taxPayable.id,
      credit: tax,
      memo: `Tax on ${input.number}`,
    });
  }

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.issueDate,
    memo: `Invoice ${input.number}`,
    sourceKind: "invoice",
    sourceId: input.documentId,
    lines: journal,
  });

  assertInvoiceStatusTransition("draft", "open");

  const { error } = await supabase
    .from("teller_documents")
    .update({
      status: "open",
      posted_entry_id: entryId,
      subtotal,
      tax,
      total,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);

  if (error) throw new Error(error.message);

  await recordDocumentJournalLink(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    journalEntryId: entryId,
    linkKind: "accrual",
  });

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    action: "document.status_changed",
    resourceKind: "invoice",
    resourceId: input.documentId,
    metadata: { number: input.number, from: "draft", to: "open", total, entryId },
  });

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    action: "invoice.opened",
    resourceKind: "invoice",
    resourceId: input.documentId,
    metadata: { number: input.number, total, entryId },
  });

  return entryId;
}

export async function postInvoicePaid(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    /** Payment amount applied on this posting (gross). */
    total: number;
    /** Invoice total when supporting partial payments. Defaults to payment amount. */
    invoiceTotal?: number;
    /** Amount already paid before this posting. */
    priorPaid?: number;
    paymentMemo?: string;
    feeAmount?: number | null;
    netAmount?: number | null;
    processorName?: string;
    actorId?: string | null;
    externalSource?: string | null;
    externalId?: string | null;
    paymentMetadata?: Record<string, unknown>;
  },
) {
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const cash = accountBySubtype(accounts, "bank") || accountByCode(accounts, "1000");
  const ar = accountBySubtype(accounts, "receivable") || accountByCode(accounts, "1100");
  if (!cash || !ar) throw new Error("Cash or AR account is missing");

  const invoiceTotal = input.invoiceTotal ?? input.total;
  const priorPaid = input.priorPaid ?? 0;
  const { paymentAmount: grossAmount } = validateDocumentPayment({
    documentTotal: invoiceTotal,
    amountPaid: priorPaid,
    paymentAmount: input.total,
  });

  await assertOrgPeriodOpen(supabase, input.organizationId, input.issueDate);

  const { feeAmount, netAmount } = resolvePaymentAmounts({
    grossAmount,
    feeAmount: input.feeAmount,
    netAmount: input.netAmount,
  });
  const feeAccount =
    feeAmount > 0.009 ? paymentProcessingFeeAccount(accounts) : null;

  const { amountPaid, fullyPaid } = invoicePaymentProgress(
    priorPaid,
    grossAmount,
    invoiceTotal,
  );

  const memo = input.paymentMemo
    ? `Payment ${input.number} · ${input.paymentMemo}`
    : `Payment ${input.number}`;

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.issueDate,
    memo,
    sourceKind: "invoice-payment",
    sourceId: input.documentId,
    lines: buildInvoicePaymentLines({
      cashAccountId: cash.id,
      arAccountId: ar.id,
      feeAccountId: feeAccount?.id,
      grossAmount,
      feeAmount,
      netAmount,
      partyId: input.partyId,
      jobId: input.jobId,
      processorName: input.processorName,
    }),
  });

  const { data: existingDoc } = await supabase
    .from("teller_documents")
    .select("metadata")
    .eq("id", input.documentId)
    .maybeSingle();

  const existingMetadata =
    existingDoc?.metadata && typeof existingDoc.metadata === "object"
      ? (existingDoc.metadata as Record<string, unknown>)
      : {};

  const paymentMetadata =
    feeAmount > 0.009
      ? {
          gross: grossAmount,
          net: netAmount,
          fee: feeAmount,
          processor: input.processorName ?? null,
        }
      : null;

  const nextStatus = invoiceStatusAfterPayment(invoiceTotal, amountPaid);
  const priorStatus: InvoiceStatus =
    priorPaid > 0.009 ? "partially_paid" : "open";
  if (priorStatus !== nextStatus) {
    assertInvoiceStatusTransition(priorStatus, nextStatus);
  }

  const { error } = await supabase
    .from("teller_documents")
    .update({
      status: nextStatus,
      amount_paid: amountPaid,
      metadata: paymentMetadata
        ? { ...existingMetadata, payment: paymentMetadata }
        : existingMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);

  if (error) throw new Error(error.message);

  const { paymentId } = await recordTellerPayment(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    documentKind: "invoice",
    partyId: input.partyId,
    jobId: input.jobId,
    amount: grossAmount,
    feeAmount,
    netAmount,
    paymentDate: input.issueDate,
    processorName: input.processorName,
    externalSource: input.externalSource ?? null,
    externalId: input.externalId ?? null,
    journalEntryId: entryId,
    metadata: input.paymentMetadata ?? {},
  });

  await recordDocumentJournalLink(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    journalEntryId: entryId,
    linkKind: "payment",
    paymentId,
  });

  await assertDocumentCacheConsistent(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    documentTotal: invoiceTotal,
    cachedAmountPaid: amountPaid,
    kind: "invoice",
  });

  const auditAction = fullyPaid
    ? "invoice.payment.completed"
    : priorPaid > 0.009
      ? "invoice.payment.partial"
      : "invoice.payment.recorded";

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: auditAction,
    resourceKind: "invoice",
    resourceId: input.documentId,
    metadata: {
      number: input.number,
      grossAmount,
      feeAmount,
      netAmount,
      amountPaid,
      invoiceTotal,
      entryId,
      paymentId,
      status: nextStatus,
    },
  });

  if (paymentId) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "payment.recorded",
      resourceKind: "payment",
      resourceId: paymentId,
      metadata: { documentId: input.documentId, amount: grossAmount, entryId },
    });
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "payment.allocated",
      resourceKind: "payment",
      resourceId: paymentId,
      metadata: { documentId: input.documentId, amount: grossAmount },
    });
  }

  if (priorStatus !== nextStatus) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "document.status_changed",
      resourceKind: "invoice",
      resourceId: input.documentId,
      metadata: { number: input.number, from: priorStatus, to: nextStatus },
    });
  }

  return { entryId, amountPaid, fullyPaid, paymentId };
}

/** Backfill processor fees when a payment was previously recorded without fee split. */
export async function reconcilePaymentProcessingFee(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    issueDate: string;
    number: string;
    grossAmount: number;
    feeAmount?: number | null;
    netAmount?: number | null;
    processorName?: string;
    partyId: string | null;
    jobId: string | null;
  },
) {
  await assertOrgPeriodOpen(supabase, input.organizationId, input.issueDate);
  const { grossAmount, feeAmount, netAmount } = resolvePaymentAmounts({
    grossAmount: input.grossAmount,
    feeAmount: input.feeAmount,
    netAmount: input.netAmount,
  });
  if (feeAmount <= 0.009) return null;

  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const cash = accountBySubtype(accounts, "bank") || accountByCode(accounts, "1000");
  const feeAccount = paymentProcessingFeeAccount(accounts);
  if (!cash || !feeAccount) {
    throw new Error("Cash or payment processing fee account is missing");
  }

  const feeMemo = input.processorName
    ? `${input.processorName} processing fee`
    : "Payment processing fee";

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.issueDate,
    memo: `Adjust ${input.number} · ${feeMemo}`,
    sourceKind: "invoice-payment-fee",
    sourceId: input.documentId,
    lines: [
      {
        account_id: feeAccount.id,
        debit: feeAmount,
        party_id: input.partyId,
        job_id: input.jobId,
        memo: feeMemo,
      },
      {
        account_id: cash.id,
        credit: feeAmount,
        party_id: input.partyId,
        job_id: input.jobId,
        memo: "Fee withheld from deposit",
      },
    ],
  });

  const { data: existingDoc } = await supabase
    .from("teller_documents")
    .select("metadata")
    .eq("id", input.documentId)
    .maybeSingle();

  const existingMetadata =
    existingDoc?.metadata && typeof existingDoc.metadata === "object"
      ? (existingDoc.metadata as Record<string, unknown>)
      : {};

  const { error } = await supabase
    .from("teller_documents")
    .update({
      metadata: {
        ...existingMetadata,
        payment: {
          gross: grossAmount,
          net: netAmount,
          fee: feeAmount,
          processor: input.processorName ?? null,
        },
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);

  if (error) throw new Error(error.message);

  await recordDocumentJournalLink(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    journalEntryId: entryId,
    linkKind: "fee",
  });

  return entryId;
}

export async function postExpense(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    amount: number;
    accountId: string;
    paid: boolean;
    costClassification?: string | null;
    jobCostCategoryId?: string | null;
  },
) {
  await assertOrgPeriodOpen(supabase, input.organizationId, input.issueDate);
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const cash = accountBySubtype(accounts, "bank") || accountByCode(accounts, "1000");
  const ap = accountBySubtype(accounts, "payable") || accountByCode(accounts, "2000");
  const creditAccount = input.paid ? cash : ap;
  if (!creditAccount) throw new Error("Cash or AP account is missing");

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.issueDate,
    memo: `Expense ${input.number}`,
    sourceKind: "expense",
    sourceId: input.documentId,
    lines: [
      {
        account_id: input.accountId,
        debit: asNumber(input.amount),
        party_id: input.partyId,
        job_id: input.jobId,
        job_cost_category_id: input.jobCostCategoryId ?? null,
        cost_classification: input.costClassification ?? "direct",
      },
      {
        account_id: creditAccount.id,
        credit: asNumber(input.amount),
        party_id: input.partyId,
        job_id: null,
      },
    ],
  });

  const { error } = await supabase
    .from("teller_documents")
    .update({
      status: input.paid ? "paid" : "open",
      amount_paid: input.paid ? asNumber(input.amount) : 0,
      posted_entry_id: entryId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);

  if (error) throw new Error(error.message);

  await recordDocumentJournalLink(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    journalEntryId: entryId,
    linkKind: "accrual",
  });

  const toStatus: ExpenseStatus = input.paid ? "paid" : "open";
  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    action: "document.status_changed",
    resourceKind: "expense",
    resourceId: input.documentId,
    metadata: { number: input.number, to: toStatus, paid: input.paid, entryId },
  });

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    action: "expense.posted",
    resourceKind: "expense",
    resourceId: input.documentId,
    metadata: { number: input.number, amount: input.amount, paid: input.paid, entryId },
  });

  return entryId;
}

/** Void a posted expense by reversing all linked GL entries. */
export async function voidExpense(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    number: string;
    voidDate: string;
    postedEntryId?: string | null;
    currentStatus?: ExpenseStatus;
    actorId?: string | null;
  },
) {
  const hasActivePayments = await documentHasActivePayments(
    supabase,
    input.organizationId,
    input.documentId,
  );
  if (hasActivePayments) {
    throw new Error(
      "Cannot void an expense with payments recorded. Reverse payments first.",
    );
  }

  const fromStatus = input.currentStatus ?? "open";
  assertExpenseStatusTransition(fromStatus, "void", { hasActivePayments: false });

  await assertOrgPeriodOpen(supabase, input.organizationId, input.voidDate);

  const { data: linkedEntries, error: entriesError } = await supabase
    .from("teller_journal_entries")
    .select("id, source_kind, created_at")
    .eq("organization_id", input.organizationId)
    .eq("source_id", input.documentId)
    .is("reverses_entry_id", null)
    .neq("source_kind", "reversal")
    .order("created_at", { ascending: false });

  if (entriesError) throw new Error(entriesError.message);

  const entryIds = new Set<string>();
  for (const entry of linkedEntries ?? []) {
    entryIds.add(entry.id as string);
  }
  if (input.postedEntryId) entryIds.add(input.postedEntryId);

  for (const entryId of entryIds) {
    const { count } = await supabase
      .from("teller_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("reverses_entry_id", entryId);

    if ((count ?? 0) > 0) continue;

    const reversalEntryId = await reverseJournalEntry(supabase, {
      organizationId: input.organizationId,
      entryId,
      entryDate: input.voidDate,
      memo: `Void expense ${input.number}`,
      sourceId: input.documentId,
      actorId: input.actorId,
    });

    await recordDocumentJournalLink(supabase, {
      organizationId: input.organizationId,
      documentId: input.documentId,
      journalEntryId: reversalEntryId,
      linkKind: "reversal",
    });
  }

  const { error: docError } = await supabase
    .from("teller_documents")
    .update({
      status: "void",
      amount_paid: 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);

  if (docError) throw new Error(docError.message);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "document.status_changed",
    resourceKind: "expense",
    resourceId: input.documentId,
    metadata: { number: input.number, from: fromStatus, to: "void" },
  });

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "expense.void",
    resourceKind: "expense",
    resourceId: input.documentId,
    metadata: { number: input.number, reversedEntries: entryIds.size },
  });
}

export async function postExpensePaid(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    /** Payment amount on this posting. */
    paymentAmount: number;
    expenseTotal?: number;
    priorPaid?: number;
    paymentMemo?: string;
    paymentMethod?: string;
    referenceNumber?: string;
    documentKind?: "expense" | "bill";
    actorId?: string | null;
  },
) {
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const cash = accountBySubtype(accounts, "bank") || accountByCode(accounts, "1000");
  const ap = accountBySubtype(accounts, "payable") || accountByCode(accounts, "2000");
  if (!cash || !ap) throw new Error("Cash or AP account is missing");

  const documentKind = input.documentKind ?? "expense";
  const expenseTotal = input.expenseTotal ?? input.paymentAmount;
  const priorPaid = input.priorPaid ?? 0;
  const { paymentAmount } = validateDocumentPayment({
    documentTotal: expenseTotal,
    amountPaid: priorPaid,
    paymentAmount: input.paymentAmount,
  });

  await assertOrgPeriodOpen(supabase, input.organizationId, input.issueDate);

  const { amountPaid, fullyPaid } = invoicePaymentProgress(
    priorPaid,
    paymentAmount,
    expenseTotal,
  );

  const memo = input.paymentMemo
    ? `Bill payment ${input.number} · ${input.paymentMemo}`
    : `Bill payment ${input.number}`;

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.issueDate,
    memo,
    sourceKind: documentKind === "bill" ? "bill-payment" : "expense-payment",
    sourceId: input.documentId,
    lines: [
      {
        account_id: ap.id,
        debit: paymentAmount,
        party_id: input.partyId,
        job_id: null,
        memo: "Clear accounts payable",
      },
      {
        account_id: cash.id,
        credit: paymentAmount,
        party_id: input.partyId,
        job_id: null,
        memo: "Vendor payment",
      },
    ],
    actorId: input.actorId,
  });

  const nextStatus = fullyPaid ? "paid" : "partially_paid";
  const { error } = await supabase
    .from("teller_documents")
    .update({
      status: nextStatus,
      amount_paid: amountPaid,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);

  if (error) throw new Error(error.message);

  const { paymentId } = await recordTellerPayment(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    documentKind,
    partyId: input.partyId,
    jobId: input.jobId,
    amount: paymentAmount,
    paymentDate: input.issueDate,
    paymentMethod: input.paymentMethod,
    referenceNumber: input.referenceNumber,
    journalEntryId: entryId,
  });

  await recordDocumentJournalLink(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    journalEntryId: entryId,
    linkKind: "payment",
    paymentId,
  });

  await assertDocumentCacheConsistent(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    documentTotal: expenseTotal,
    cachedAmountPaid: amountPaid,
    kind: documentKind === "bill" ? "bill" : "expense",
  });

  if (documentKind === "bill") {
    return { entryId, amountPaid, fullyPaid, paymentId };
  }

  const auditAction = fullyPaid
    ? "expense.payment.completed"
    : "expense.payment.recorded";

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: auditAction,
    resourceKind: "expense",
    resourceId: input.documentId,
    metadata: {
      number: input.number,
      paymentAmount,
      amountPaid,
      expenseTotal,
      entryId,
      paymentId,
    },
  });

  if (paymentId) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "payment.recorded",
      resourceKind: "payment",
      resourceId: paymentId,
      metadata: { documentId: input.documentId, amount: paymentAmount, entryId },
    });
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "payment.allocated",
      resourceKind: "payment",
      resourceId: paymentId,
      metadata: { documentId: input.documentId, amount: paymentAmount },
    });
  }

  return { entryId, amountPaid, fullyPaid, paymentId };
}
