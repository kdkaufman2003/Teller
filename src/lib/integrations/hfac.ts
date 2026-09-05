import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveDocumentAmountPaid } from "@/lib/accounting/balances";
import { nextNumber, revenueCodeForItemType } from "@/lib/accounting/accounts";
import { postInvoiceOpen, postInvoicePaid, reconcilePaymentProcessingFee, voidInvoice } from "@/lib/accounting/post";
import { recordTellerPayment } from "@/lib/accounting/payments";
import { invoicePaymentProgress, resolvePaymentAmounts } from "@/lib/accounting/payment-fees";
import { asNumber } from "@/lib/format";
import {
  HFAC_EXTERNAL_SOURCE,
  LEGACY_HFAC_EXTERNAL_SOURCES,
} from "@/lib/integrations/constants";
import {
  integrationEventSeen,
  paymentIdempotencyKey,
  recordIntegrationEvent,
} from "@/lib/integrations/idempotency";
import {
  mapHfacJobType,
  quoteJobMetadata,
} from "@/lib/integrations/hfac-quote";

export type HfacQuoteLine = {
  description?: string;
  name?: string;
  qty?: number;
  quantity?: number;
  unit_price?: number;
  price?: number;
  amount?: number;
  type?: string;
  item_type?: string;
};

/** Payload Hassle Free AC sends when a deal is won. */
export type HfacWonQuote = {
  id: string;
  name?: string;
  customer_name?: string;
  customer_email?: string;
  total_amount?: number | string;
  status?: string;
  notes?: string;
  line_items?: HfacQuoteLine[] | string;
  dealer_account_id?: string | null;
  /** HFAC deal type — free-form string; defaults to "deal". */
  source?: string;
  job_type?: string;
  salesperson?: string;
  equipment_cost?: number | string;
  labor_cost?: number | string;
  materials_cost?: number | string;
  equipment_cost_cents?: number;
  labor_cost_cents?: number;
  materials_cost_cents?: number;
  cogs?: {
    equipment?: number | string;
    labor?: number | string;
    materials?: number | string;
  };
};

function parseLines(raw: HfacWonQuote["line_items"]): HfacQuoteLine[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function lineAmount(line: HfacQuoteLine): number {
  if (line.amount != null) return asNumber(line.amount);
  const qty = asNumber(line.qty ?? line.quantity, 1);
  const price = asNumber(line.unit_price ?? line.price);
  return qty * price;
}

function lineType(line: HfacQuoteLine): string {
  const raw = String(line.item_type || line.type || "equipment").toLowerCase();
  if (raw.includes("labor") || raw.includes("install")) return "labor";
  if (raw.includes("part") || raw.includes("accessor")) return "parts";
  if (raw.includes("service")) return "service";
  return "equipment";
}

export async function importWonQuotesFromHfac(
  supabase: SupabaseClient,
  organizationId: string,
  quotes: HfacWonQuote[],
  options: { createJobs: boolean },
) {
  const [{ data: accounts }, { data: existingDocs }, { data: existingJobs }] =
    await Promise.all([
      supabase
        .from("teller_accounts")
        .select("id, code, type")
        .eq("organization_id", organizationId),
      supabase
        .from("teller_documents")
        .select("id, number, external_id")
        .eq("organization_id", organizationId)
        .eq("kind", "invoice")
        .in("external_source", [...LEGACY_HFAC_EXTERNAL_SOURCES]),
      supabase
        .from("teller_jobs")
        .select("id, job_number, external_id")
        .eq("organization_id", organizationId)
        .in("external_source", [...LEGACY_HFAC_EXTERNAL_SOURCES]),
    ]);

  const invoiceNumbers = (existingDocs ?? []).map((row) => row.number as string);
  const jobNumbers = (existingJobs ?? []).map((row) => row.job_number as string);
  const importedIds = new Set(
    (existingDocs ?? []).map((row) => String(row.external_id || "")),
  );
  const accountByCode = new Map(
    (accounts ?? []).map((row) => [row.code as string, row.id as string]),
  );

  let invoices = 0;
  let jobs = 0;
  let skipped = 0;

  for (const quote of quotes) {
    const source = quote.source || "deal";
    const externalId = `${source}:${quote.id}`;
    if (importedIds.has(externalId)) {
      skipped += 1;
      continue;
    }

    let partyId: string | null = null;
    if (quote.dealer_account_id) {
      const { data: party } = await supabase
        .from("teller_parties")
        .select("id")
        .eq("organization_id", organizationId)
        .in("external_source", [...LEGACY_HFAC_EXTERNAL_SOURCES])
        .eq("external_id", quote.dealer_account_id)
        .maybeSingle();
      partyId = party?.id ?? null;
    }

    if (!partyId && quote.customer_name) {
      const { data: byName } = await supabase
        .from("teller_parties")
        .select("id")
        .eq("organization_id", organizationId)
        .ilike("name", quote.customer_name)
        .maybeSingle();
      if (byName) {
        partyId = byName.id;
      } else {
        const { data: created } = await supabase
          .from("teller_parties")
          .insert({
            organization_id: organizationId,
            kind: "customer",
            name: quote.customer_name,
            email: quote.customer_email || "",
            notes: "Imported from Hassle Free AC",
            external_source: HFAC_EXTERNAL_SOURCE,
            external_id: quote.dealer_account_id || null,
          })
          .select("id")
          .single();
        partyId = created?.id ?? null;
      }
    }

    let jobId: string | null = null;
    if (options.createJobs) {
      const jobNumber = nextNumber("JOB", jobNumbers);
      jobNumbers.push(jobNumber);
      const { data: job, error: jobError } = await supabase
        .from("teller_jobs")
        .insert({
          organization_id: organizationId,
          job_number: jobNumber,
          name: quote.name || quote.customer_name || "HFAC job",
          party_id: partyId,
          status: "estimate",
          job_type: mapHfacJobType(quote.job_type),
          quoted_amount: asNumber(quote.total_amount),
          external_source: HFAC_EXTERNAL_SOURCE,
          external_id: externalId,
          metadata: quoteJobMetadata(quote),
        })
        .select("id")
        .single();
      if (jobError) throw new Error(jobError.message);
      jobId = job?.id ?? null;
      jobs += 1;
    }

    const lines = parseLines(quote.line_items);
    const invoiceNumber = nextNumber("INV", invoiceNumbers);
    invoiceNumbers.push(invoiceNumber);

    const builtLines = (
      lines.length
        ? lines
        : [
            {
              description: quote.name || "Won Hassle Free AC deal",
              amount: asNumber(quote.total_amount),
              item_type: "equipment",
              quantity: 1,
              unit_price: asNumber(quote.total_amount),
            },
          ]
    ).map((line, index) => {
      const amount = lineAmount(line);
      const itemType = lineType(line);
      const code = revenueCodeForItemType(itemType, accounts ?? []);
      return {
        description:
          line.description || line.name || quote.name || "Deal line",
        quantity: asNumber(line.qty ?? line.quantity, 1),
        unit_price: asNumber(line.unit_price ?? line.price ?? amount),
        amount,
        item_type: itemType,
        account_id: accountByCode.get(code) ?? null,
        sort_order: index,
      };
    });

    const subtotal = builtLines.reduce((sum, line) => sum + line.amount, 0);

    const { data: doc, error: docError } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: organizationId,
        kind: "invoice",
        number: invoiceNumber,
        party_id: partyId,
        job_id: jobId,
        status: "draft",
        memo: quote.notes || `Imported from Hassle Free AC (${source})`,
        subtotal,
        tax: 0,
        total: subtotal,
        external_source: HFAC_EXTERNAL_SOURCE,
        external_id: externalId,
        metadata: { hfac: quoteJobMetadata(quote).hfac },
      })
      .select("id")
      .single();

    if (docError || !doc) throw new Error(docError?.message || "Invoice insert failed");

    const { error: lineError } = await supabase.from("teller_document_lines").insert(
      builtLines.map((line) => ({ ...line, document_id: doc.id })),
    );
    if (lineError) throw new Error(lineError.message);

    invoices += 1;
    importedIds.add(externalId);
  }

  return { invoices, jobs, skipped };
}

export async function recordHfacWebhookDelivery(
  supabase: SupabaseClient,
  organizationId: string,
  result: Record<string, unknown>,
  event: "quotes" | "subscribers" | "payments" | "billing" = "quotes",
) {
  const { data: current } = await supabase
    .from("teller_integrations")
    .select("last_sync_summary")
    .eq("organization_id", organizationId)
    .in("provider", ["hfac", "quoter"])
    .maybeSingle();

  const previous =
    current?.last_sync_summary && typeof current.last_sync_summary === "object"
      ? (current.last_sync_summary as Record<string, unknown>)
      : {};

  await supabase.from("teller_integrations").upsert({
    organization_id: organizationId,
    provider: "hfac",
    enabled: true,
    last_synced_at: new Date().toISOString(),
    last_sync_summary: {
      ...previous,
      [event]: result,
      via: "webhook",
    },
    updated_at: new Date().toISOString(),
  });
}

/** Subscriber / dealer account from Hassle Free AC. */
export type HfacSubscriber = {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  notes?: string;
  status?: string;
  /** When true, Teller marks the party inactive in notes (no hard delete). */
  deleted?: boolean;
};

export async function importSubscribersFromHfac(
  supabase: SupabaseClient,
  organizationId: string,
  subscribers: HfacSubscriber[],
) {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const subscriber of subscribers) {
    if (!subscriber.id || !subscriber.name?.trim()) {
      skipped += 1;
      continue;
    }

    const externalId = String(subscriber.id);
    const statusNote = subscriber.deleted
      ? "Inactive in Hassle Free AC"
      : subscriber.status
        ? `Status: ${subscriber.status}`
        : "";
    const notes = [subscriber.notes, statusNote].filter(Boolean).join(" · ");

    const { data: existing } = await supabase
      .from("teller_parties")
      .select("id")
      .eq("organization_id", organizationId)
      .in("external_source", [...LEGACY_HFAC_EXTERNAL_SOURCES])
      .eq("external_id", externalId)
      .maybeSingle();

    const payload = {
      organization_id: organizationId,
      kind: "customer" as const,
      name: subscriber.name.trim(),
      email: subscriber.email?.trim() || "",
      phone: subscriber.phone?.trim() || "",
      notes: notes || "Imported from Hassle Free AC",
      external_source: HFAC_EXTERNAL_SOURCE,
      external_id: externalId,
      updated_at: new Date().toISOString(),
    };

    if (existing?.id) {
      const { error } = await supabase
        .from("teller_parties")
        .update(payload)
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
      updated += 1;
    } else {
      const { error } = await supabase.from("teller_parties").insert(payload);
      if (error) throw new Error(error.message);
      created += 1;
    }
  }

  return { created, updated, skipped };
}

/** Stripe or other processor payment forwarded from Hassle Free AC. Amounts in dollars. */
export type HfacPayment = {
  /** Gross invoice amount collected from the customer. */
  amount: number;
  paidAt: string;
  /** Processor fee withheld (e.g. Stripe fee). Optional if netAmount is sent. */
  feeAmount?: number;
  /** Cash deposited after fees. Optional if feeAmount is sent. */
  netAmount?: number;
  /** Processor name, e.g. stripe, square, paypal. */
  processor?: string;
  /** Stripe fee in cents (HFAC field name). */
  stripeFeeCents?: number;
  /** Net deposit in cents (HFAC field name). */
  netReceivedCents?: number;
  hfacSubscriberId?: string;
  hfacInvoiceId?: string;
  hfacDealId?: string;
  stripePaymentIntentId?: string;
  stripeInvoiceId?: string;
  stripeCustomerId?: string;
  currency?: string;
  memo?: string;
};

type InvoiceRow = {
  id: string;
  number: string;
  status: string;
  party_id: string | null;
  job_id: string | null;
  issue_date: string;
  total: number;
};

async function findInvoiceForPayment(
  supabase: SupabaseClient,
  organizationId: string,
  payment: HfacPayment,
): Promise<(InvoiceRow & { amount_paid?: number }) | null> {
  const select = "id, number, status, party_id, job_id, issue_date, total, amount_paid";

  if (payment.hfacInvoiceId) {
    const { data } = await supabase
      .from("teller_documents")
      .select(select)
      .eq("organization_id", organizationId)
      .eq("kind", "invoice")
      .in("external_source", [...LEGACY_HFAC_EXTERNAL_SOURCES])
      .eq("external_id", payment.hfacInvoiceId)
      .maybeSingle();
    if (data) return data as InvoiceRow;
  }

  if (payment.hfacDealId) {
    const candidates = [`deal:${payment.hfacDealId}`, payment.hfacDealId];
    for (const externalId of candidates) {
      const { data } = await supabase
        .from("teller_documents")
        .select(select)
        .eq("organization_id", organizationId)
        .eq("kind", "invoice")
        .in("external_source", [...LEGACY_HFAC_EXTERNAL_SOURCES])
        .eq("external_id", externalId)
        .maybeSingle();
      if (data) return data as InvoiceRow;
    }
  }

  if (payment.hfacSubscriberId) {
    const { data: party } = await supabase
      .from("teller_parties")
      .select("id")
      .eq("organization_id", organizationId)
      .in("external_source", [...LEGACY_HFAC_EXTERNAL_SOURCES])
      .eq("external_id", payment.hfacSubscriberId)
      .maybeSingle();

    if (party?.id) {
      const { data: invoices } = await supabase
        .from("teller_documents")
        .select(select)
        .eq("organization_id", organizationId)
        .eq("kind", "invoice")
        .eq("party_id", party.id)
        .in("status", ["draft", "open"])
        .order("issue_date", { ascending: false });

      const amount = asNumber(payment.amount);
      const match = (invoices ?? []).find(
        (row) => Math.abs(asNumber(row.total) - amount) < 0.01,
      );
      if (match) return match as InvoiceRow;
    }
  }

  return null;
}

export async function importPaymentFromHfac(
  supabase: SupabaseClient,
  organizationId: string,
  payment: HfacPayment,
) {
  if (payment.amount == null || !payment.paidAt) {
    throw new Error("payment.amount and payment.paidAt are required");
  }

  const idempotencyKey = paymentIdempotencyKey(payment);
  if (idempotencyKey) {
    const seen = await integrationEventSeen(supabase, {
      organizationId,
      eventKind: "payment",
      idempotencyKey,
    });
    if (seen) {
      return { skipped: true, reason: "duplicate_payment" as const };
    }
  }

  const invoice = await findInvoiceForPayment(supabase, organizationId, payment);
  if (!invoice) {
    return { skipped: true, reason: "invoice_not_found" as const };
  }

  if (invoice.status === "paid") {
    return {
      skipped: true,
      reason: "already_paid" as const,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
    };
  }

  const invoiceTotal = asNumber(invoice.total);
  const priorPaid = await resolveDocumentAmountPaid(
    supabase,
    organizationId,
    invoice.id,
    asNumber(invoice.amount_paid),
  );
  const paymentAmount = asNumber(payment.amount) || invoiceTotal;
  const { fullyPaid } = invoicePaymentProgress(priorPaid, paymentAmount, invoiceTotal);

  if (priorPaid >= invoiceTotal - 0.009) {
    return {
      skipped: true,
      reason: "already_paid" as const,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
    };
  }

  const paidDate = payment.paidAt.slice(0, 10);
  const paymentMemo = payment.stripePaymentIntentId
    ? `Stripe ${payment.stripePaymentIntentId}`
    : payment.stripeInvoiceId
      ? `Stripe invoice ${payment.stripeInvoiceId}`
      : "Hassle Free AC payment";

  if (invoice.status === "draft") {
    const [{ data: lines }, { data: doc }] = await Promise.all([
      supabase
        .from("teller_document_lines")
        .select("amount, account_id, description")
        .eq("document_id", invoice.id),
      supabase
        .from("teller_documents")
        .select("tax")
        .eq("id", invoice.id)
        .maybeSingle(),
    ]);

    await postInvoiceOpen(supabase, {
      organizationId,
      documentId: invoice.id,
      partyId: invoice.party_id,
      jobId: invoice.job_id,
      issueDate: paidDate,
      number: invoice.number,
      tax: asNumber(doc?.tax),
      lines: lines ?? [],
    });
  }

  const total = paymentAmount;
  const processorName =
    payment.processor?.trim() ||
    (payment.stripePaymentIntentId || payment.stripeInvoiceId ? "Stripe" : undefined);
  const feeAmount =
    payment.feeAmount ??
    (payment.stripeFeeCents != null ? payment.stripeFeeCents / 100 : undefined);
  const netAmount =
    payment.netAmount ??
    (payment.netReceivedCents != null ? payment.netReceivedCents / 100 : undefined);

  const { entryId, amountPaid } = await postInvoicePaid(supabase, {
    organizationId,
    documentId: invoice.id,
    partyId: invoice.party_id,
    jobId: invoice.job_id,
    issueDate: paidDate,
    number: invoice.number,
    total,
    invoiceTotal,
    priorPaid,
    feeAmount,
    netAmount,
    processorName,
    paymentMemo: payment.memo ? `${paymentMemo} · ${payment.memo}` : paymentMemo,
  });

  const { feeAmount: resolvedFee, netAmount: resolvedNet } = resolvePaymentAmounts({
    grossAmount: total,
    feeAmount,
    netAmount,
  });

  const paymentExternalId =
    payment.stripePaymentIntentId?.trim() ||
    payment.stripeInvoiceId?.trim() ||
    payment.hfacDealId?.trim() ||
    idempotencyKey;

  await recordTellerPayment(supabase, {
    organizationId,
    documentId: invoice.id,
    partyId: invoice.party_id,
    jobId: invoice.job_id,
    amount: total,
    feeAmount: resolvedFee,
    netAmount: resolvedNet,
    paymentDate: paidDate,
    processorName,
    externalSource: paymentExternalId ? HFAC_EXTERNAL_SOURCE : null,
    externalId: paymentExternalId,
    journalEntryId: entryId,
    metadata: {
      stripePaymentIntentId: payment.stripePaymentIntentId ?? null,
      stripeInvoiceId: payment.stripeInvoiceId ?? null,
      hfacDealId: payment.hfacDealId ?? null,
    },
  });

  if (idempotencyKey) {
    await recordIntegrationEvent(supabase, {
      organizationId,
      eventKind: "payment",
      idempotencyKey,
      result: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        amount: total,
        amountPaid,
        fullyPaid,
        entryId,
      },
    });
  }

  return {
    skipped: false,
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    amount: total,
    amountPaid,
    fullyPaid,
    feeAmount: resolvedFee,
    netAmount: resolvedNet,
  };
}

/** Platform billing ledger row from Hassle Free AC contractor profiles. */
export type HfacBillingEntry = {
  id: string;
  companyId: string;
  date: string;
  description: string;
  amountCents: number;
  status: "invoiced" | "paid" | "pending" | "credit";
  reference?: string;
  stripeInvoiceId?: string;
  /** Processor fee in cents. HFAC may send `stripeFeeCents` instead. */
  feeAmountCents?: number;
  stripeFeeCents?: number;
  /** Net deposit in cents. HFAC may send `netReceivedCents` instead. */
  netAmountCents?: number;
  netReceivedCents?: number;
  processor?: string;
};

export function normalizeBillingEntry(entry: HfacBillingEntry): HfacBillingEntry {
  return {
    ...entry,
    feeAmountCents: entry.feeAmountCents ?? entry.stripeFeeCents,
    netAmountCents: entry.netAmountCents ?? entry.netReceivedCents,
    processor: entry.processor ?? (entry.stripeInvoiceId ? "stripe" : undefined),
  };
}

export function billingEntryIsOpen(status: HfacBillingEntry["status"]): boolean {
  return status === "invoiced" || status === "pending";
}

/** Stripe void / HFAC credit rows — invoice should not remain open in Teller. */
export function billingEntryIsVoid(status: HfacBillingEntry["status"]): boolean {
  return status === "credit";
}

export function billingEntryShouldPostOpen(status: HfacBillingEntry["status"]): boolean {
  return status === "invoiced" || status === "pending" || status === "paid";
}

export function buildBillingFeeFromEntry(
  entry: HfacBillingEntry,
  grossAmount: number,
):
  | {
      feeAmount?: number;
      netAmount?: number;
      processorName?: string;
    }
  | undefined {
  const normalized = normalizeBillingEntry(entry);
  if (normalized.feeAmountCents == null && normalized.netAmountCents == null) {
    return undefined;
  }

  return {
    feeAmount:
      normalized.feeAmountCents != null ? normalized.feeAmountCents / 100 : undefined,
    netAmount:
      normalized.netAmountCents != null ? normalized.netAmountCents / 100 : undefined,
    processorName: normalized.processor,
  };
}

export function paymentFeeRecorded(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const payment = (metadata as { payment?: { fee?: number } }).payment;
  return typeof payment?.fee === "number" && payment.fee > 0;
}

export function billingExternalId(entry: Pick<HfacBillingEntry, "id" | "companyId" | "stripeInvoiceId">): string {
  if (entry.stripeInvoiceId?.trim()) {
    return `stripe-invoice:${entry.stripeInvoiceId.trim()}`;
  }
  return `billing:${entry.companyId}:${entry.id}`;
}

export function isHfacBillingExternalId(externalId: string | null | undefined): boolean {
  if (!externalId) return false;
  return externalId.startsWith("stripe-invoice:") || externalId.startsWith("billing:");
}

/** Void HFAC billing invoices that no longer exist in the HFAC ledger snapshot. */
export async function reconcileRemovedBillingInvoices(
  supabase: SupabaseClient,
  organizationId: string,
  activeExternalIds: string[],
  voidDate = new Date().toISOString().slice(0, 10),
) {
  const active = new Set(activeExternalIds);
  const { data: invoices, error } = await supabase
    .from("teller_documents")
    .select("id, number, status, posted_entry_id, external_id")
    .eq("organization_id", organizationId)
    .eq("kind", "invoice")
    .in("external_source", [...LEGACY_HFAC_EXTERNAL_SOURCES])
    .neq("status", "void");

  if (error) throw new Error(error.message);

  let voided = 0;
  for (const invoice of invoices ?? []) {
    const externalId = invoice.external_id as string | null;
    if (!isHfacBillingExternalId(externalId)) continue;
    if (active.has(externalId!)) continue;

    await voidBillingInvoiceFromHfac(supabase, organizationId, invoice, voidDate);
    voided += 1;
  }

  return voided;
}

type BillingInvoiceRow = {
  id: string;
  number: string;
  status: string;
  party_id: string | null;
  job_id: string | null;
  total: number;
  metadata?: unknown;
  posted_entry_id?: string | null;
};

async function voidBillingInvoiceFromHfac(
  supabase: SupabaseClient,
  organizationId: string,
  invoice: Pick<BillingInvoiceRow, "id" | "number" | "status" | "posted_entry_id">,
  voidDate: string,
) {
  if (invoice.status === "void") return;

  if (invoice.status === "draft") {
    const { error } = await supabase
      .from("teller_documents")
      .update({ status: "void", amount_paid: 0, updated_at: new Date().toISOString() })
      .eq("id", invoice.id);
    if (error) throw new Error(error.message);
    return;
  }

  await voidInvoice(supabase, {
    organizationId,
    documentId: invoice.id,
    number: invoice.number,
    voidDate,
    postedEntryId: invoice.posted_entry_id,
  });
}

async function syncBillingInvoiceDraft(
  supabase: SupabaseClient,
  documentId: string,
  input: {
    amount: number;
    description: string;
    issueDate: string;
    revenueAccountId: string | null;
  },
) {
  await supabase
    .from("teller_documents")
    .update({
      subtotal: input.amount,
      tax: 0,
      total: input.amount,
      issue_date: input.issueDate,
      updated_at: new Date().toISOString(),
    })
    .eq("id", documentId);

  const { data: lines } = await supabase
    .from("teller_document_lines")
    .select("id")
    .eq("document_id", documentId)
    .order("sort_order")
    .limit(1);

  if (lines?.[0]?.id) {
    await supabase
      .from("teller_document_lines")
      .update({
        description: input.description,
        quantity: 1,
        unit_price: input.amount,
        amount: input.amount,
        account_id: input.revenueAccountId,
      })
      .eq("id", lines[0].id);
  }
}

async function postBillingInvoicePaid(
  supabase: SupabaseClient,
  organizationId: string,
  invoice: BillingInvoiceRow,
  paidDate: string,
  paymentMemo: string,
  fee?: {
    feeAmount?: number;
    netAmount?: number;
    processorName?: string;
  },
) {
  if (invoice.status === "draft") {
    const [{ data: lines }, { data: doc }] = await Promise.all([
      supabase
        .from("teller_document_lines")
        .select("amount, account_id, description")
        .eq("document_id", invoice.id),
      supabase
        .from("teller_documents")
        .select("tax")
        .eq("id", invoice.id)
        .maybeSingle(),
    ]);

    await postInvoiceOpen(supabase, {
      organizationId,
      documentId: invoice.id,
      partyId: invoice.party_id,
      jobId: invoice.job_id,
      issueDate: paidDate,
      number: invoice.number,
      tax: asNumber(doc?.tax),
      lines: lines ?? [],
    });
  }

  await postInvoicePaid(supabase, {
    organizationId,
    documentId: invoice.id,
    partyId: invoice.party_id,
    jobId: invoice.job_id,
    issueDate: paidDate,
    number: invoice.number,
    total: asNumber(invoice.total),
    feeAmount: fee?.feeAmount,
    netAmount: fee?.netAmount,
    processorName: fee?.processorName,
    paymentMemo,
  });
}

/** Import HFAC platform billing ledger rows as Teller invoices (open or paid). */
export async function importBillingEntriesFromHfac(
  supabase: SupabaseClient,
  organizationId: string,
  entries: HfacBillingEntry[],
) {
  let created = 0;
  let updated = 0;
  let paid = 0;
  let voided = 0;
  let skipped = 0;

  const { data: existingDocs } = await supabase
    .from("teller_documents")
    .select("number")
    .eq("organization_id", organizationId)
    .eq("kind", "invoice");

  const invoiceNumbers = (existingDocs ?? []).map((row) => row.number);

  const { data: accounts } = await supabase
    .from("teller_accounts")
    .select("id, code, type")
    .eq("organization_id", organizationId);

  const accountByCode = new Map((accounts ?? []).map((row) => [row.code, row.id]));
  const revenueAccountId =
    accountByCode.get(revenueCodeForItemType("subscription", accounts ?? [])) ?? null;

  for (const rawEntry of entries) {
    const entry = normalizeBillingEntry(rawEntry);
    if (!entry.id?.trim() || !entry.companyId?.trim()) {
      skipped += 1;
      continue;
    }

    const externalId = billingExternalId(entry);
    const issueDate = entry.date?.slice(0, 10) || new Date().toISOString().slice(0, 10);

    if (billingEntryIsVoid(entry.status)) {
      const { data: existingVoid } = await supabase
        .from("teller_documents")
        .select("id, number, status, posted_entry_id")
        .eq("organization_id", organizationId)
        .eq("kind", "invoice")
        .in("external_source", [...LEGACY_HFAC_EXTERNAL_SOURCES])
        .eq("external_id", externalId)
        .maybeSingle();

      if (existingVoid && existingVoid.status !== "void") {
        await voidBillingInvoiceFromHfac(supabase, organizationId, existingVoid, issueDate);
        voided += 1;
        updated += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    const amountCents = Math.round(asNumber(entry.amountCents));
    if (amountCents <= 0) {
      skipped += 1;
      continue;
    }

    const amount = amountCents / 100;
    const description = entry.description?.trim() || "Platform billing";

    const { data: party } = await supabase
      .from("teller_parties")
      .select("id")
      .eq("organization_id", organizationId)
      .in("external_source", [...LEGACY_HFAC_EXTERNAL_SOURCES])
      .eq("external_id", entry.companyId.trim())
      .maybeSingle();

    if (!party?.id) {
      skipped += 1;
      continue;
    }

    const paymentMemo = entry.stripeInvoiceId
      ? `Stripe invoice ${entry.stripeInvoiceId}`
      : entry.reference?.trim()
        ? `HFAC ${entry.reference.trim()}`
        : "Hassle Free AC billing";

    const billingFee = buildBillingFeeFromEntry(entry, amount);

    const { data: existing } = await supabase
      .from("teller_documents")
      .select("id, number, status, party_id, job_id, total, metadata")
      .eq("organization_id", organizationId)
      .eq("kind", "invoice")
      .in("external_source", [...LEGACY_HFAC_EXTERNAL_SOURCES])
      .eq("external_id", externalId)
      .maybeSingle();

    if (existing) {
      const row = existing as BillingInvoiceRow;
      if (entry.status === "paid" && row.status !== "paid") {
        if (Math.abs(asNumber(row.total) - amount) > 0.01) {
          await syncBillingInvoiceDraft(supabase, row.id, {
            amount,
            description,
            issueDate,
            revenueAccountId,
          });
        }
        await postBillingInvoicePaid(
          supabase,
          organizationId,
          { ...row, total: amount },
          issueDate,
          paymentMemo,
          billingFee,
        );
        paid += 1;
        updated += 1;
      } else if (entry.status === "paid" && row.status === "paid") {
        if (billingFee && !paymentFeeRecorded(row.metadata)) {
          await reconcilePaymentProcessingFee(supabase, {
            organizationId,
            documentId: row.id,
            issueDate,
            number: row.number,
            grossAmount: asNumber(row.total) || amount,
            feeAmount: billingFee.feeAmount,
            netAmount: billingFee.netAmount,
            processorName: billingFee.processorName,
            partyId: row.party_id,
            jobId: row.job_id,
          });
          updated += 1;
        } else {
          skipped += 1;
        }
      } else if (billingEntryIsOpen(entry.status) && row.status === "draft") {
        if (Math.abs(asNumber(row.total) - amount) > 0.01) {
          await syncBillingInvoiceDraft(supabase, row.id, {
            amount,
            description,
            issueDate,
            revenueAccountId,
          });
        }
        const { data: lines } = await supabase
          .from("teller_document_lines")
          .select("amount, account_id, description")
          .eq("document_id", row.id);
        await postInvoiceOpen(supabase, {
          organizationId,
          documentId: row.id,
          partyId: row.party_id,
          jobId: row.job_id,
          issueDate,
          number: row.number,
          tax: 0,
          lines: (lines ?? []).map((line) => ({
            ...line,
            amount: asNumber(line.amount) || amount,
            description: line.description || description,
          })),
        });
        updated += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    const invoiceNumber = nextNumber("INV", invoiceNumbers);
    invoiceNumbers.push(invoiceNumber);

    const memoParts = [entry.reference?.trim(), "Imported from Hassle Free AC billing"].filter(Boolean);

    const { data: doc, error: docError } = await supabase
      .from("teller_documents")
      .insert({
        organization_id: organizationId,
        kind: "invoice",
        number: invoiceNumber,
        party_id: party.id,
        job_id: null,
        status: "draft",
        memo: memoParts.join(" · "),
        issue_date: issueDate,
        subtotal: amount,
        tax: 0,
        total: amount,
        external_source: HFAC_EXTERNAL_SOURCE,
        external_id: externalId,
      })
      .select("id, number, status, party_id, job_id, total")
      .single();

    if (docError || !doc) throw new Error(docError?.message || "Invoice insert failed");

    const { error: lineError } = await supabase.from("teller_document_lines").insert({
      document_id: doc.id,
      description,
      quantity: 1,
      unit_price: amount,
      amount,
      item_type: "subscription",
      account_id: revenueAccountId,
      sort_order: 0,
    });
    if (lineError) throw new Error(lineError.message);

    created += 1;

    const row = doc as BillingInvoiceRow;
    if (entry.status === "paid") {
      await postBillingInvoicePaid(
        supabase,
        organizationId,
        row,
        issueDate,
        paymentMemo,
        billingFee,
      );
      paid += 1;
    } else if (billingEntryIsOpen(entry.status)) {
      await postInvoiceOpen(supabase, {
        organizationId,
        documentId: row.id,
        partyId: row.party_id,
        jobId: row.job_id,
        issueDate,
        number: row.number,
        tax: 0,
        lines: [{ description, amount, account_id: revenueAccountId }],
      });
    }
  }

  return { created, updated, paid, voided, skipped };
}

/** @deprecated use HfacWonQuote */
export type QuoterQuote = HfacWonQuote & {
  source: "mini_split" | "central_split" | "commercial" | "custom" | "rtu";
};

/** @deprecated use importWonQuotesFromHfac */
export const importWonQuotes = importWonQuotesFromHfac;
