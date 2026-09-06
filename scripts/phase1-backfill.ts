#!/usr/bin/env node
/**
 * Phase 1 pre-backfill report + optional allocation/journal-link backfill.
 *
 * Dry run (default):
 *   npm run phase1:backfill
 *
 * Apply:
 *   APPLY=1 npm run phase1:backfill
 *
 * Single org:
 *   ORGANIZATION_ID=<uuid> npm run phase1:backfill
 */
import "./load-env.mjs";
import { createClient } from "@supabase/supabase-js";
import { backfillPaymentAllocations } from "../src/lib/accounting/allocations";
import { backfillDocumentJournalLinks } from "../src/lib/accounting/journal-links";

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function reportOrg(supabase: ReturnType<typeof createClient>, organizationId: string) {
  const [{ count: paymentCount }, { data: payments }, { data: voidInvoices }] = await Promise.all([
    supabase
      .from("teller_payments")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId),
    supabase
      .from("teller_payments")
      .select("id, document_id, external_source, external_id, journal_entry_id, status")
      .eq("organization_id", organizationId),
    supabase
      .from("teller_documents")
      .select("id, number, status")
      .eq("organization_id", organizationId)
      .eq("kind", "invoice")
      .eq("status", "void"),
  ]);

  const withDocument = (payments ?? []).filter((row) => row.document_id);
  const withoutDocument = (payments ?? []).filter((row) => !row.document_id);

  const externalKeys = new Map<string, number>();
  for (const row of payments ?? []) {
    if (!row.external_source || !row.external_id) continue;
    const key = `${row.external_source}:${row.external_id}`;
    externalKeys.set(key, (externalKeys.get(key) ?? 0) + 1);
  }
  const duplicateExternals = [...externalKeys.entries()].filter(([, count]) => count > 1);

  const voidWithPayments: string[] = [];
  for (const invoice of voidInvoices ?? []) {
    const { count } = await supabase
      .from("teller_payments")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("document_id", invoice.id)
      .eq("status", "posted");
    if ((count ?? 0) > 0) voidWithPayments.push(invoice.number as string);
  }

  const { count: partialInvoices } = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("kind", "invoice")
    .eq("status", "partially_paid");

  return {
    organizationId,
    paymentCount: paymentCount ?? 0,
    paymentsWithDocument: withDocument.length,
    paymentsWithoutDocument: withoutDocument.length,
    duplicateExternalIds: duplicateExternals.map(([key, count]) => ({ key, count })),
    voidInvoicesWithPayments: voidWithPayments,
    partiallyPaidInvoices: partialInvoices ?? 0,
  };
}

async function main() {
  const supabase = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const apply = process.env.APPLY === "1";
  const organizationId = process.env.ORGANIZATION_ID?.trim();

  const { data: orgs } = organizationId
    ? { data: [{ id: organizationId }] }
    : await supabase.from("teller_organizations").select("id");

  const reports = [];
  for (const org of orgs ?? []) {
    reports.push(await reportOrg(supabase, org.id as string));
  }

  console.log(JSON.stringify({ phase: "pre-backfill-report", reports }, null, 2));

  for (const org of orgs ?? []) {
    const orgId = org.id as string;
    const allocationBackfill = await backfillPaymentAllocations(supabase, orgId, { apply });
    const journalBackfill = await backfillDocumentJournalLinks(supabase, orgId, { apply });

    console.log(
      JSON.stringify(
        {
          organizationId: orgId,
          apply,
          allocationBackfill: {
            inserted: allocationBackfill.inserted,
            skipped: allocationBackfill.skipped,
            flagged: allocationBackfill.flagged,
          },
          journalLinkBackfill: {
            inserted: journalBackfill.inserted,
            skipped: journalBackfill.skipped,
            flagged: journalBackfill.flagged,
          },
        },
        null,
        2,
      ),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
