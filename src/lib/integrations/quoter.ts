import type { SupabaseClient } from "@supabase/supabase-js";
import { nextNumber, revenueCodeForItemType } from "@/lib/accounting/accounts";
import { asNumber } from "@/lib/format";

export type QuoterDealer = {
  id: string;
  name: string;
  dcps_name?: string | null;
};

export type QuoterQuoteLine = {
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

export type QuoterQuote = {
  id: string;
  name?: string;
  customer_name?: string;
  customer_email?: string;
  total_amount?: number | string;
  status?: string;
  notes?: string;
  line_items?: QuoterQuoteLine[] | string;
  dealer_account_id?: string | null;
  source: "mini_split" | "central_split" | "commercial" | "custom" | "rtu";
};

function parseLines(raw: QuoterQuote["line_items"]): QuoterQuoteLine[] {
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

function lineAmount(line: QuoterQuoteLine): number {
  if (line.amount != null) return asNumber(line.amount);
  const qty = asNumber(line.qty ?? line.quantity, 1);
  const price = asNumber(line.unit_price ?? line.price);
  return qty * price;
}

function lineType(line: QuoterQuoteLine): string {
  const raw = String(line.item_type || line.type || "equipment").toLowerCase();
  if (raw.includes("labor") || raw.includes("install")) return "labor";
  if (raw.includes("part") || raw.includes("accessor")) return "parts";
  if (raw.includes("service")) return "service";
  return "equipment";
}

export async function fetchQuoterDealers(
  supabase: SupabaseClient,
): Promise<QuoterDealer[]> {
  const { data, error } = await supabase
    .from("dealer_accounts")
    .select("id, name, dcps_name")
    .order("name");
  if (error) throw new Error(`Quoter dealers: ${error.message}`);
  return (data ?? []) as QuoterDealer[];
}

const QUOTE_TABLES: { table: string; source: QuoterQuote["source"] }[] = [
  { table: "mini_split_quotes", source: "mini_split" },
  { table: "central_split_quotes", source: "central_split" },
  { table: "commercial_quotes", source: "commercial" },
  { table: "custom_quotes", source: "custom" },
];

export async function fetchWonQuoterQuotes(
  supabase: SupabaseClient,
): Promise<QuoterQuote[]> {
  const quotes: QuoterQuote[] = [];

  for (const { table, source } of QUOTE_TABLES) {
    const { data, error } = await supabase
      .from(table)
      .select(
        "id, name, customer_name, customer_email, total_amount, status, notes, line_items, dealer_account_id",
      )
      .eq("status", "won")
      .order("updated_at", { ascending: false })
      .limit(200);

    if (error) {
      if (error.code === "PGRST205" || error.message.includes("does not exist")) {
        continue;
      }
      // Column differences across quote tables — retry a slimmer select.
      const slim = await supabase
        .from(table)
        .select("id, name, customer_name, total_amount, status, notes")
        .eq("status", "won")
        .limit(200);
      if (slim.error) continue;
      for (const row of slim.data ?? []) {
        quotes.push({ ...(row as QuoterQuote), source });
      }
      continue;
    }

    for (const row of data ?? []) {
      quotes.push({ ...(row as QuoterQuote), source });
    }
  }

  return quotes;
}

export async function upsertDealersAsCustomers(
  supabase: SupabaseClient,
  organizationId: string,
  dealers: QuoterDealer[],
) {
  let created = 0;
  let updated = 0;

  for (const dealer of dealers) {
    const name = dealer.name || dealer.dcps_name || "Quoter dealer";
    const { data: existing } = await supabase
      .from("teller_parties")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("external_source", "quoter")
      .eq("external_id", dealer.id)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("teller_parties")
        .update({ name, notes: dealer.dcps_name || "", updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      updated += 1;
      continue;
    }

    const { error } = await supabase.from("teller_parties").insert({
      organization_id: organizationId,
      kind: "customer",
      name,
      notes: dealer.dcps_name || "",
      external_source: "quoter",
      external_id: dealer.id,
    });
    if (error) throw new Error(error.message);
    created += 1;
  }

  return { created, updated };
}

export async function importWonQuotes(
  supabase: SupabaseClient,
  organizationId: string,
  quotes: QuoterQuote[],
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
        .eq("external_source", "quoter"),
      supabase
        .from("teller_jobs")
        .select("id, job_number, external_id")
        .eq("organization_id", organizationId)
        .eq("external_source", "quoter"),
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
    const externalId = `${quote.source}:${quote.id}`;
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
        .eq("external_source", "quoter")
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
            notes: "Imported from Quoter quote",
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
          name: quote.name || quote.customer_name || "Quoter job",
          party_id: partyId,
          status: "estimate",
          job_type: "install",
          quoted_amount: asNumber(quote.total_amount),
          external_source: "quoter",
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
              description: quote.name || "Won Quoter quote",
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
          line.description || line.name || quote.name || "Quote line",
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
        memo: quote.notes || `Imported from Quoter (${quote.source})`,
        subtotal,
        tax: 0,
        total: subtotal,
        external_source: "quoter",
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

export async function syncQuoter(
  supabase: SupabaseClient,
  organizationId: string,
  createJobs: boolean,
) {
  const dealers = await fetchQuoterDealers(supabase);
  const dealerResult = await upsertDealersAsCustomers(
    supabase,
    organizationId,
    dealers,
  );
  const quotes = await fetchWonQuoterQuotes(supabase);
  const quoteResult = await importWonQuotes(supabase, organizationId, quotes, {
    createJobs,
  });

  const summary = {
    dealersCreated: dealerResult.created,
    dealersUpdated: dealerResult.updated,
    invoicesCreated: quoteResult.invoices,
    jobsCreated: quoteResult.jobs,
    quotesSkipped: quoteResult.skipped,
    quotesSeen: quotes.length,
  };

  await supabase.from("teller_integrations").upsert({
    organization_id: organizationId,
    provider: "quoter",
    enabled: true,
    last_synced_at: new Date().toISOString(),
    last_sync_summary: summary,
    updated_at: new Date().toISOString(),
  });

  return summary;
}
