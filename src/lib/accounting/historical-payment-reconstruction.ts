import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { accountByCode, accountBySubtype } from "./accounts";
import { recordPaymentAllocation } from "./allocations";
import { roundMoney } from "./payment-fees";
import { computeArControlSubledgerTotal } from "./party-balances";
import { reconcileSubledgersToGl } from "./subledger";

const TOLERANCE = 0.009;
const HFAC_EXTERNAL_SOURCE = "hfac";

export type ReconstructionClassification = "SAFE" | "AMBIGUOUS" | "INVALID";

export type ExternalIdentifierKind = "real_stripe" | "journal_anchor" | "none";

export type HistoricalPaymentEvidence = {
  invoice: {
    id: string;
    number: string;
    organizationId: string;
    partyId: string | null;
    partyName: string | null;
    total: number;
    amountPaid: number;
    status: string;
    issueDate: string;
    paidDate: string | null;
    externalSource: string | null;
    externalId: string | null;
    metadata: Record<string, unknown>;
  };
  paymentJournal: {
    id: string;
    entryDate: string;
    sourceKind: string;
    sourceId: string;
    memo: string | null;
    debitAccount: { code: string; name: string; subtype: string | null; amount: number };
    creditAccount: { code: string; name: string; subtype: string | null; amount: number };
    amount: number;
    partyId: string | null;
  };
  feeJournal: {
    id: string;
    entryDate: string;
    memo: string | null;
    feeAmount: number;
  } | null;
  external: {
    stripeInvoiceId: string | null;
    stripePaymentIntentId: string | null;
    externalSource: string | null;
    externalId: string | null;
    identifierKind: ExternalIdentifierKind;
  };
  existingPayment: { id: string } | null;
  existingAllocation: { id: string } | null;
};

export type HistoricalPaymentProposal = {
  classification: ReconstructionClassification;
  reason: string;
  evidence: HistoricalPaymentEvidence;
  proposedPayment: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    amount: number;
    feeAmount: number;
    netAmount: number;
    paymentDate: string;
    paymentType: "customer_payment";
    status: "posted";
    journalEntryId: string;
    processor: string | null;
    paymentMethod: string | null;
    externalSource: string | null;
    externalId: string | null;
    metadata: Record<string, unknown>;
  } | null;
  proposedAllocation: {
    documentId: string;
    amount: number;
    allocationKind: "invoice_payment";
  } | null;
  proposedPaymentInsert: boolean;
  proposedAllocationInsert: boolean;
};

export type HistoricalPaymentReconstructionResult = {
  apply: boolean;
  organizationId: string;
  eventsFound: number;
  summary: {
    SAFE: number;
    AMBIGUOUS: number;
    INVALID: number;
    paymentInserts: number;
    allocationInserts: number;
    skipped: number;
  };
  events: HistoricalPaymentProposal[];
  arReconciliation: {
    current: { gl: number; subledger: number; difference: number };
    expectedAfter: { gl: number; subledger: number; difference: number };
  } | null;
  depositAccount: {
    hasCustomerDepositsAccount: boolean;
    customerDepositsAccount: { code: string; name: string; subtype: string | null } | null;
    deferredRevenueAccount: { code: string; name: string } | null;
    phase3RequiresProvisionedAccount: boolean;
    note: string;
  } | null;
};

type AccountRow = {
  id: string;
  code: string;
  name: string;
  subtype?: string | null;
  type: string;
};

type JournalLineRow = {
  account_id: string;
  debit: number | string;
  credit: number | string;
  party_id: string | null;
  memo?: string | null;
};

function parseStripeInvoiceId(input: string | null | undefined): string | null {
  if (!input) return null;
  const memoMatch = input.match(/\b(in_[A-Za-z0-9]+)\b/);
  if (memoMatch) return memoMatch[1];
  const prefixed = input.match(/^stripe-invoice:(in_[A-Za-z0-9]+)$/);
  if (prefixed) return prefixed[1];
  return null;
}

function parseStripePaymentIntentId(input: string | null | undefined): string | null {
  if (!input) return null;
  const match = input.match(/\b(pi_[A-Za-z0-9]+)\b/);
  return match ? match[1] : null;
}

function paymentMetadataFromDocument(
  metadata: Record<string, unknown>,
): { gross: number; fee: number; net: number; processor: string | null } {
  const payment =
    metadata.payment && typeof metadata.payment === "object"
      ? (metadata.payment as Record<string, unknown>)
      : {};
  const gross = roundMoney(asNumber(payment.gross));
  const fee = roundMoney(asNumber(payment.fee));
  const net = roundMoney(asNumber(payment.net));
  const processor =
    typeof payment.processor === "string" && payment.processor.trim()
      ? payment.processor.trim()
      : null;
  return { gross, fee, net, processor };
}

async function fetchGlArBalance(
  supabase: SupabaseClient,
  organizationId: string,
  arAccount: AccountRow,
): Promise<number> {
  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("debit, credit, entry_id")
    .eq("account_id", arAccount.id);

  const entryIds = [...new Set((lines ?? []).map((line) => line.entry_id as string))];
  if (!entryIds.length) return 0;

  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id, reverses_entry_id")
    .eq("organization_id", organizationId)
    .in("id", entryIds);

  const reversalEntries = new Set(
    (entries ?? [])
      .filter((entry) => entry.reverses_entry_id)
      .map((entry) => entry.id as string),
  );

  const { data: reversals } = await supabase
    .from("teller_journal_entries")
    .select("reverses_entry_id")
    .eq("organization_id", organizationId)
    .in("reverses_entry_id", entryIds);

  const reversedOriginals = new Set(
    (reversals ?? []).map((row) => row.reverses_entry_id as string),
  );

  return roundMoney(
    (lines ?? []).reduce((sum, line) => {
      const entryId = line.entry_id as string;
      if (reversalEntries.has(entryId) || reversedOriginals.has(entryId)) return sum;
      return sum + asNumber(line.debit) - asNumber(line.credit);
    }, 0),
  );
}

async function analyzePaymentJournal(
  supabase: SupabaseClient,
  organizationId: string,
  entry: {
    id: string;
    entry_date: string;
    source_kind: string;
    source_id: string;
    memo: string | null;
    reverses_entry_id: string | null;
  },
  accounts: AccountRow[],
  partyNames: Map<string, string>,
): Promise<HistoricalPaymentProposal> {
  const arAccount = accountBySubtype(accounts, "receivable") || accountByCode(accounts, "1100");
  const cashAccount = accountBySubtype(accounts, "bank") || accountByCode(accounts, "1000");
  const feeAccount =
    accountBySubtype(accounts, "payment_fee") || accountByCode(accounts, "5100");

  const emptyEvidence: HistoricalPaymentEvidence = {
    invoice: {
      id: entry.source_id,
      number: "",
      organizationId,
      partyId: null,
      partyName: null,
      total: 0,
      amountPaid: 0,
      status: "",
      issueDate: "",
      paidDate: null,
      externalSource: null,
      externalId: null,
      metadata: {},
    },
    paymentJournal: {
      id: entry.id,
      entryDate: entry.entry_date,
      sourceKind: entry.source_kind,
      sourceId: entry.source_id,
      memo: entry.memo,
      debitAccount: { code: "", name: "", subtype: null, amount: 0 },
      creditAccount: { code: "", name: "", subtype: null, amount: 0 },
      amount: 0,
      partyId: null,
    },
    feeJournal: null,
    external: {
      stripeInvoiceId: null,
      stripePaymentIntentId: null,
      externalSource: null,
      externalId: null,
      identifierKind: "none",
    },
    existingPayment: null,
    existingAllocation: null,
  };

  if (entry.source_kind !== "invoice-payment") {
    return {
      classification: "INVALID",
      reason: "unsupported_source_kind",
      evidence: emptyEvidence,
      proposedPayment: null,
      proposedAllocation: null,
      proposedPaymentInsert: false,
      proposedAllocationInsert: false,
    };
  }

  if (entry.reverses_entry_id) {
    return {
      classification: "INVALID",
      reason: "reversal_journal",
      evidence: emptyEvidence,
      proposedPayment: null,
      proposedAllocation: null,
      proposedPaymentInsert: false,
      proposedAllocationInsert: false,
    };
  }

  const { data: reversedBy } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("reverses_entry_id", entry.id)
    .maybeSingle();

  if (reversedBy?.id) {
    return {
      classification: "INVALID",
      reason: "journal_reversed",
      evidence: emptyEvidence,
      proposedPayment: null,
      proposedAllocation: null,
      proposedPaymentInsert: false,
      proposedAllocationInsert: false,
    };
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from("teller_documents")
    .select(
      "id, kind, number, organization_id, party_id, job_id, total, amount_paid, status, issue_date, external_source, external_id, metadata",
    )
    .eq("id", entry.source_id)
    .maybeSingle();

  if (invoiceError) throw new Error(invoiceError.message);

  if (!invoice || invoice.organization_id !== organizationId || invoice.kind !== "invoice") {
    return {
      classification: "INVALID",
      reason: "invoice_missing_or_cross_org",
      evidence: emptyEvidence,
      proposedPayment: null,
      proposedAllocation: null,
      proposedPaymentInsert: false,
      proposedAllocationInsert: false,
    };
  }

  const invoiceMetadata =
    invoice.metadata && typeof invoice.metadata === "object"
      ? (invoice.metadata as Record<string, unknown>)
      : {};

  const { data: lines, error: linesError } = await supabase
    .from("teller_journal_lines")
    .select("account_id, debit, credit, party_id, memo")
    .eq("entry_id", entry.id);

  if (linesError) throw new Error(linesError.message);

  const accountById = new Map(accounts.map((row) => [row.id, row]));
  const journalLines = (lines ?? []) as JournalLineRow[];

  let arCredit = 0;
  let cashDebit = 0;
  let feeDebit = 0;
  let partyId: string | null = null;
  let debitAccount = { code: "", name: "", subtype: null as string | null, amount: 0 };
  let creditAccount = { code: "", name: "", subtype: null as string | null, amount: 0 };

  for (const line of journalLines) {
    const account = accountById.get(line.account_id as string);
    if (!account) continue;
    partyId = partyId ?? ((line.party_id as string | null) ?? null);

    if (arAccount && line.account_id === arAccount.id) {
      const credit = roundMoney(asNumber(line.credit));
      arCredit += credit;
      if (credit > TOLERANCE) {
        creditAccount = {
          code: account.code,
          name: account.name,
          subtype: account.subtype ?? null,
          amount: credit,
        };
      }
    }

    if (cashAccount && line.account_id === cashAccount.id) {
      const debit = roundMoney(asNumber(line.debit));
      cashDebit += debit;
      if (debit > TOLERANCE) {
        debitAccount = {
          code: account.code,
          name: account.name,
          subtype: account.subtype ?? null,
          amount: debit,
        };
      }
    }

    if (feeAccount && line.account_id === feeAccount.id) {
      feeDebit += roundMoney(asNumber(line.debit));
    }
  }

  const paymentAmount = roundMoney(arCredit);
  const invoiceTotal = roundMoney(asNumber(invoice.total));

  const { data: feeEntry } = await supabase
    .from("teller_journal_entries")
    .select("id, entry_date, memo, source_kind")
    .eq("organization_id", organizationId)
    .eq("source_id", invoice.id)
    .eq("source_kind", "invoice-payment-fee")
    .is("reverses_entry_id", null)
    .maybeSingle();

  let feeJournal: HistoricalPaymentEvidence["feeJournal"] = null;
  let feeAmountFromJournal = 0;
  if (feeEntry?.id) {
    const { data: feeLines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit, account_id")
      .eq("entry_id", feeEntry.id);

    feeAmountFromJournal = roundMoney(
      (feeLines ?? [])
        .filter((line) => feeAccount && line.account_id === feeAccount.id)
        .reduce((sum, line) => sum + asNumber(line.debit), 0),
    );

    feeJournal = {
      id: feeEntry.id as string,
      entryDate: feeEntry.entry_date as string,
      memo: feeEntry.memo as string | null,
      feeAmount: feeAmountFromJournal,
    };
  }

  const metadataAmounts = paymentMetadataFromDocument(invoiceMetadata);
  const feeAmount =
    metadataAmounts.fee > TOLERANCE
      ? metadataAmounts.fee
      : feeDebit > TOLERANCE
        ? feeDebit
        : feeAmountFromJournal;
  const netAmount =
    metadataAmounts.net > TOLERANCE
      ? metadataAmounts.net
      : roundMoney(Math.max(0, paymentAmount - feeAmount));
  const processor = metadataAmounts.processor ?? "stripe";

  const stripeInvoiceId =
    parseStripeInvoiceId(entry.memo) ??
    parseStripeInvoiceId(invoice.external_id as string | null) ??
    null;
  const stripePaymentIntentId = parseStripePaymentIntentId(entry.memo);

  let externalSource: string | null = null;
  let externalId: string | null = null;
  let identifierKind: ExternalIdentifierKind = "journal_anchor";

  if (stripePaymentIntentId || stripeInvoiceId) {
    externalSource = HFAC_EXTERNAL_SOURCE;
    externalId = stripePaymentIntentId ?? stripeInvoiceId;
    identifierKind = "real_stripe";
  }

  const { data: existingPayment } = await supabase
    .from("teller_payments")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("journal_entry_id", entry.id)
    .maybeSingle();

  let existingAllocation: { id: string } | null = null;
  if (existingPayment?.id) {
    const { data: allocation } = await supabase
      .from("teller_payment_allocations")
      .select("id")
      .eq("payment_id", existingPayment.id)
      .eq("document_id", invoice.id)
      .eq("allocation_kind", "invoice_payment")
      .maybeSingle();
    existingAllocation = allocation?.id ? { id: allocation.id as string } : null;
  }

  const evidence: HistoricalPaymentEvidence = {
    invoice: {
      id: invoice.id as string,
      number: invoice.number as string,
      organizationId,
      partyId: (invoice.party_id as string | null) ?? null,
      partyName: invoice.party_id ? partyNames.get(invoice.party_id as string) ?? null : null,
      total: invoiceTotal,
      amountPaid: roundMoney(asNumber(invoice.amount_paid)),
      status: invoice.status as string,
      issueDate: invoice.issue_date as string,
      paidDate: entry.entry_date as string,
      externalSource: (invoice.external_source as string | null) ?? null,
      externalId: (invoice.external_id as string | null) ?? null,
      metadata: invoiceMetadata,
    },
    paymentJournal: {
      id: entry.id,
      entryDate: entry.entry_date as string,
      sourceKind: entry.source_kind as string,
      sourceId: entry.source_id as string,
      memo: entry.memo as string | null,
      debitAccount,
      creditAccount,
      amount: paymentAmount,
      partyId,
    },
    feeJournal,
    external: {
      stripeInvoiceId,
      stripePaymentIntentId,
      externalSource,
      externalId,
      identifierKind,
    },
    existingPayment: existingPayment?.id ? { id: existingPayment.id as string } : null,
    existingAllocation,
  };

  if (paymentAmount <= TOLERANCE) {
    return {
      classification: "INVALID",
      reason: "journal_does_not_clear_ar",
      evidence,
      proposedPayment: null,
      proposedAllocation: null,
      proposedPaymentInsert: false,
      proposedAllocationInsert: false,
    };
  }

  if (!arAccount || !cashAccount || arCredit <= TOLERANCE || cashDebit <= TOLERANCE) {
    return {
      classification: "INVALID",
      reason: "missing_ar_or_cash_lines",
      evidence,
      proposedPayment: null,
      proposedAllocation: null,
      proposedPaymentInsert: false,
      proposedAllocationInsert: false,
    };
  }

  if (Math.abs(cashDebit - arCredit) > TOLERANCE && feeDebit <= TOLERANCE) {
    return {
      classification: "AMBIGUOUS",
      reason: "cash_debit_does_not_match_ar_credit",
      evidence,
      proposedPayment: null,
      proposedAllocation: null,
      proposedPaymentInsert: false,
      proposedAllocationInsert: false,
    };
  }

  if (invoice.party_id && partyId && invoice.party_id !== partyId) {
    return {
      classification: "AMBIGUOUS",
      reason: "party_mismatch_between_invoice_and_journal",
      evidence,
      proposedPayment: null,
      proposedAllocation: null,
      proposedPaymentInsert: false,
      proposedAllocationInsert: false,
    };
  }

  const { data: siblingPayments } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("source_id", invoice.id)
    .eq("source_kind", "invoice-payment")
    .is("reverses_entry_id", null)
    .neq("id", entry.id);

  if ((siblingPayments ?? []).length > 0) {
    return {
      classification: "AMBIGUOUS",
      reason: "multiple_invoice_payment_journals",
      evidence,
      proposedPayment: null,
      proposedAllocation: null,
      proposedPaymentInsert: false,
      proposedAllocationInsert: false,
    };
  }

  if (paymentAmount - invoiceTotal > TOLERANCE) {
    return {
      classification: "INVALID",
      reason: "payment_exceeds_invoice_total",
      evidence,
      proposedPayment: null,
      proposedAllocation: null,
      proposedPaymentInsert: false,
      proposedAllocationInsert: false,
    };
  }

  const proposedPayment = {
    organizationId,
    documentId: invoice.id as string,
    partyId: (invoice.party_id as string | null) ?? partyId,
    jobId: (invoice.job_id as string | null) ?? null,
    amount: paymentAmount,
    feeAmount: roundMoney(feeAmount),
    netAmount,
    paymentDate: entry.entry_date as string,
    paymentType: "customer_payment" as const,
    status: "posted" as const,
    journalEntryId: entry.id,
    processor,
    paymentMethod: processor ? "card" : null,
    externalSource,
    externalId,
    metadata: {
      source: "historical_payment_reconstruction",
      reconstruction_anchor: "journal_entry_id",
      journal_entry_id: entry.id,
      stripe_invoice_id: stripeInvoiceId,
      stripe_payment_intent_id: stripePaymentIntentId,
      identifier_kind: identifierKind,
    },
  };

  const proposedAllocation = {
    documentId: invoice.id as string,
    amount: paymentAmount,
    allocationKind: "invoice_payment" as const,
  };

  const proposedPaymentInsert = !existingPayment?.id;
  const proposedAllocationInsert = !existingAllocation?.id;

  if (!proposedPaymentInsert && !proposedAllocationInsert) {
    return {
      classification: "SAFE",
      reason: "already_reconstructed",
      evidence,
      proposedPayment,
      proposedAllocation,
      proposedPaymentInsert: false,
      proposedAllocationInsert: false,
    };
  }

  return {
    classification: "SAFE",
    reason: "deterministic_journal_evidence",
    evidence,
    proposedPayment,
    proposedAllocation,
    proposedPaymentInsert,
    proposedAllocationInsert,
  };
}

async function applyReconstruction(
  supabase: SupabaseClient,
  event: HistoricalPaymentProposal,
): Promise<{ paymentId: string; paymentInserted: boolean; allocationInserted: boolean }> {
  if (!event.proposedPayment || !event.proposedAllocation) {
    throw new Error("Cannot apply event without proposed payment/allocation");
  }

  let paymentId = event.evidence.existingPayment?.id ?? null;
  let paymentInserted = false;

  if (!paymentId) {
    const { data, error } = await supabase
      .from("teller_payments")
      .insert({
        organization_id: event.proposedPayment.organizationId,
        document_id: event.proposedPayment.documentId,
        party_id: event.proposedPayment.partyId,
        job_id: event.proposedPayment.jobId,
        amount: event.proposedPayment.amount,
        fee_amount: event.proposedPayment.feeAmount,
        net_amount: event.proposedPayment.netAmount,
        payment_date: event.proposedPayment.paymentDate,
        processor: event.proposedPayment.processor,
        payment_method: event.proposedPayment.paymentMethod,
        external_source: event.proposedPayment.externalSource,
        external_id: event.proposedPayment.externalId,
        journal_entry_id: event.proposedPayment.journalEntryId,
        payment_type: event.proposedPayment.paymentType,
        status: event.proposedPayment.status,
        metadata: event.proposedPayment.metadata,
      })
      .select("id")
      .single();

    if (error) {
      if (error.message.includes("duplicate")) {
        const { data: existing } = await supabase
          .from("teller_payments")
          .select("id")
          .eq("organization_id", event.proposedPayment.organizationId)
          .eq("journal_entry_id", event.proposedPayment.journalEntryId)
          .maybeSingle();
        paymentId = (existing?.id as string) ?? null;
      } else {
        throw new Error(error.message);
      }
    } else {
      paymentId = data!.id as string;
      paymentInserted = true;
    }
  }

  if (!paymentId) throw new Error("Payment reconstruction failed to resolve payment id");

  let allocationInserted = false;
  if (!event.evidence.existingAllocation?.id) {
    const result = await recordPaymentAllocation(supabase, {
      organizationId: event.proposedPayment.organizationId,
      paymentId,
      documentId: event.proposedAllocation.documentId,
      amount: event.proposedAllocation.amount,
      allocationKind: event.proposedAllocation.allocationKind,
    });
    allocationInserted = result.inserted;
  }

  return { paymentId, paymentInserted, allocationInserted };
}

export async function reconstructHistoricalPayments(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    apply?: boolean;
    invoiceNumbers?: string[];
  },
): Promise<HistoricalPaymentReconstructionResult> {
  const apply = input.apply === true;

  const { data: accounts, error: accountsError } = await supabase
    .from("teller_accounts")
    .select("id, code, name, subtype, type")
    .eq("organization_id", input.organizationId);

  if (accountsError) throw new Error(accountsError.message);
  const accountRows = (accounts ?? []) as AccountRow[];

  const { data: parties } = await supabase
    .from("teller_parties")
    .select("id, name")
    .eq("organization_id", input.organizationId);

  const partyNames = new Map((parties ?? []).map((row) => [row.id as string, row.name as string]));

  let journalQuery = supabase
    .from("teller_journal_entries")
    .select("id, entry_date, source_kind, source_id, memo, reverses_entry_id")
    .eq("organization_id", input.organizationId)
    .eq("source_kind", "invoice-payment")
    .not("source_id", "is", null)
    .is("reverses_entry_id", null);

  const { data: journalEntries, error: journalError } = await journalQuery;
  if (journalError) throw new Error(journalError.message);

  let entries = journalEntries ?? [];
  if (input.invoiceNumbers?.length) {
    const { data: docs } = await supabase
      .from("teller_documents")
      .select("id, number")
      .eq("organization_id", input.organizationId)
      .in("number", input.invoiceNumbers);
    const docIds = new Set((docs ?? []).map((row) => row.id as string));
    entries = entries.filter((entry) => docIds.has(entry.source_id as string));
  }

  const events: HistoricalPaymentProposal[] = [];
  for (const entry of entries) {
    const { data: existingPayment } = await supabase
      .from("teller_payments")
      .select("id")
      .eq("journal_entry_id", entry.id)
      .maybeSingle();

    if (existingPayment?.id) {
      const proposal = await analyzePaymentJournal(
        supabase,
        input.organizationId,
        entry,
        accountRows,
        partyNames,
      );
      events.push(proposal);
      continue;
    }

    events.push(
      await analyzePaymentJournal(
        supabase,
        input.organizationId,
        entry,
        accountRows,
        partyNames,
      ),
    );
  }

  const summary = {
    SAFE: events.filter((event) => event.classification === "SAFE").length,
    AMBIGUOUS: events.filter((event) => event.classification === "AMBIGUOUS").length,
    INVALID: events.filter((event) => event.classification === "INVALID").length,
    paymentInserts: events.filter((event) => event.proposedPaymentInsert).length,
    allocationInserts: events.filter((event) => event.proposedAllocationInsert).length,
    skipped: events.filter(
      (event) =>
        event.classification === "SAFE" &&
        !event.proposedPaymentInsert &&
        !event.proposedAllocationInsert,
    ).length,
  };

  if (apply) {
    for (const event of events) {
      if (event.classification !== "SAFE") continue;
      if (!event.proposedPaymentInsert && !event.proposedAllocationInsert) continue;
      await applyReconstruction(supabase, event);
    }
  }

  const arAccountRow =
    accountRows.find((a) => a.subtype === "receivable") ||
    accountRows.find((a) => a.code === "1100");
  const depositAccountRow =
    accountRows.find((a) => a.subtype === "deposit") ||
    accountRows.find((a) => a.code === "2300");
  const deferredAccountRow =
    accountRows.find((a) => a.subtype === "deferred") ||
    accountRows.find((a) => a.code === "2100");

  let arReconciliation: HistoricalPaymentReconstructionResult["arReconciliation"] = null;
  if (arAccountRow) {
    const currentGl = await fetchGlArBalance(
      supabase,
      input.organizationId,
      arAccountRow,
    );
    const currentSubledger = await computeArControlSubledgerTotal(
      supabase,
      input.organizationId,
    );
    const currentDifference = roundMoney(
      Math.abs(currentGl - currentSubledger.netSubledgerBalance),
    );

    const safeAllocationTotal = roundMoney(
      events
        .filter((event) => event.classification === "SAFE" && event.proposedAllocationInsert)
        .reduce((sum, event) => sum + (event.proposedAllocation?.amount ?? 0), 0),
    );

    const expectedSubledger = roundMoney(
      Math.max(0, currentSubledger.netSubledgerBalance - safeAllocationTotal),
    );
    const expectedDifference = roundMoney(Math.abs(currentGl - expectedSubledger));

    arReconciliation = {
      current: {
        gl: currentGl,
        subledger: currentSubledger.netSubledgerBalance,
        difference: currentDifference,
      },
      expectedAfter: {
        gl: currentGl,
        subledger: expectedSubledger,
        difference: expectedDifference,
      },
    };
  }

  const depositAccountInfo: HistoricalPaymentReconstructionResult["depositAccount"] = {
    hasCustomerDepositsAccount: Boolean(depositAccountRow),
    customerDepositsAccount: depositAccountRow
      ? {
          code: depositAccountRow.code,
          name: depositAccountRow.name,
          subtype: depositAccountRow.subtype ?? null,
        }
      : null,
    deferredRevenueAccount: deferredAccountRow
      ? { code: deferredAccountRow.code, name: deferredAccountRow.name }
      : null,
    phase3RequiresProvisionedAccount: !depositAccountRow,
    note: depositAccountRow
      ? "Phase 3 deposit RPCs accept an explicit liability account id; this org already has a Customer Deposits account."
      : "Phase 3 deposit receipt requires a liability account (subtype deposit or code 2300). deposits.ts resolves customerDepositsAccount() and throws if missing. Deferred Revenue 2100 is not used automatically.",
  };

  return {
    apply,
    organizationId: input.organizationId,
    eventsFound: events.length,
    summary,
    events,
    arReconciliation,
    depositAccount: depositAccountInfo,
  };
}

export async function previewArAfterReconstruction(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{
  reconcileSubledgers: Awaited<ReturnType<typeof reconcileSubledgersToGl>>;
}> {
  return {
    reconcileSubledgers: await reconcileSubledgersToGl(supabase, organizationId),
  };
}
