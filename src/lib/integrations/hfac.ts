import type { SupabaseClient } from "@supabase/supabase-js";
import { nextNumber, revenueCodeForItemType } from "@/lib/accounting/accounts";
import { postInvoiceOpen, postInvoicePaid } from "@/lib/accounting/post";
import { asNumber } from "@/lib/format";
import {
  HFAC_EXTERNAL_SOURCE,
  LEGACY_HFAC_EXTERNAL_SOURCES,
} from "@/lib/integrations/constants";

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
          job_type: "install",
          quoted_amount: asNumber(quote.total_amount),
          external_source: HFAC_EXTERNAL_SOURCE,
          external_id: externalId,
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
  event: "quotes" | "subscribers" | "payments" = "quotes",
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

/** Stripe payment notification forwarded from Hassle Free AC. Amounts in dollars. */
export type HfacPayment = {
  amount: number;
  paidAt: string;
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
): Promise<InvoiceRow | null> {
  const select = "id, number, status, party_id, job_id, issue_date, total";

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

async function paymentAlreadyRecorded(
  supabase: SupabaseClient,
  organizationId: string,
  stripePaymentIntentId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("source_kind", "invoice-payment")
    .ilike("memo", `%${stripePaymentIntentId}%`)
    .maybeSingle();
  return Boolean(data?.id);
}

export async function importPaymentFromHfac(
  supabase: SupabaseClient,
  organizationId: string,
  payment: HfacPayment,
) {
  if (payment.amount == null || !payment.paidAt) {
    throw new Error("payment.amount and payment.paidAt are required");
  }

  if (payment.stripePaymentIntentId) {
    const duplicate = await paymentAlreadyRecorded(
      supabase,
      organizationId,
      payment.stripePaymentIntentId,
    );
    if (duplicate) {
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

  const total = asNumber(payment.amount) || asNumber(invoice.total);
  await postInvoicePaid(supabase, {
    organizationId,
    documentId: invoice.id,
    partyId: invoice.party_id,
    jobId: invoice.job_id,
    issueDate: paidDate,
    number: invoice.number,
    total,
    paymentMemo: payment.memo ? `${paymentMemo} · ${payment.memo}` : paymentMemo,
  });

  return {
    skipped: false,
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    amount: total,
  };
}

/** @deprecated use HfacWonQuote */
export type QuoterQuote = HfacWonQuote & {
  source: "mini_split" | "central_split" | "commercial" | "custom" | "rtu";
};

/** @deprecated use importWonQuotesFromHfac */
export const importWonQuotes = importWonQuotesFromHfac;
