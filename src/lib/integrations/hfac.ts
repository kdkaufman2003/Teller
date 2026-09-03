import type { SupabaseClient } from "@supabase/supabase-js";
import { nextNumber, revenueCodeForItemType } from "@/lib/accounting/accounts";
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
  result: { invoices: number; jobs: number; skipped: number },
) {
  await supabase.from("teller_integrations").upsert({
    organization_id: organizationId,
    provider: "hfac",
    enabled: true,
    last_synced_at: new Date().toISOString(),
    last_sync_summary: { ...result, via: "webhook" },
    updated_at: new Date().toISOString(),
  });
}

/** @deprecated use HfacWonQuote */
export type QuoterQuote = HfacWonQuote & {
  source: "mini_split" | "central_split" | "commercial" | "custom" | "rtu";
};

/** @deprecated use importWonQuotesFromHfac */
export const importWonQuotes = importWonQuotesFromHfac;
