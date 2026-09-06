#!/usr/bin/env node
/**
 * Reconstruct missing historical teller_payments + allocations from existing journals.
 *
 * Dry run (default):
 *   npm run reconstruct:historical-payments
 *
 * Apply (explicit approval only):
 *   APPLY=1 npm run reconstruct:historical-payments
 *
 * Single org / invoice filter:
 *   ORGANIZATION_ID=<uuid> INVOICE_NUMBERS=INV-1001,INV-1003 npm run reconstruct:historical-payments
 */
import "./load-env.mjs";
import { createClient } from "@supabase/supabase-js";
import { reconstructHistoricalPayments } from "../src/lib/accounting/historical-payment-reconstruction";

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function projectRef(url: string) {
  return url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? "MISSING";
}

async function main() {
  const apply = process.env.APPLY === "1";
  const supabase = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const organizationId = process.env.ORGANIZATION_ID?.trim();
  const invoiceNumbers = process.env.INVOICE_NUMBERS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const { data: orgs, error: orgError } = organizationId
    ? { data: [{ id: organizationId }], error: null }
    : await supabase.from("teller_organizations").select("id, name");

  if (orgError) throw new Error(orgError.message);

  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  console.log(
    JSON.stringify(
      {
        phase: "historical-payment-reconstruction",
        database: {
          projectRef: projectRef(url),
          refMatchesExpected: projectRef(url) === "ypixbxicdecwfafculha",
          apply,
          dryRunReadOnly: !apply,
        },
      },
      null,
      2,
    ),
  );

  for (const org of orgs ?? []) {
    const orgId = org.id as string;
    const result = await reconstructHistoricalPayments(supabase, {
      organizationId: orgId,
      apply,
      invoiceNumbers,
    });

    const reportEvents = result.events.map((event) => ({
      invoice: event.evidence.invoice.number,
      invoiceId: event.evidence.invoice.id,
      paymentJournalId: event.evidence.paymentJournal.id,
      amount: event.evidence.paymentJournal.amount,
      paymentDate: event.evidence.paymentJournal.entryDate,
      customer: event.evidence.invoice.partyName,
      externalIdentifier: {
        kind: event.evidence.external.identifierKind,
        source: event.evidence.external.externalSource,
        id: event.evidence.external.externalId,
        stripeInvoiceId: event.evidence.external.stripeInvoiceId,
      },
      existingPayment: Boolean(event.evidence.existingPayment),
      existingAllocation: Boolean(event.evidence.existingAllocation),
      proposedPaymentInsert: event.proposedPaymentInsert,
      proposedAllocationInsert: event.proposedAllocationInsert,
      classification: event.classification,
      reason: event.reason,
      paymentJournal: {
        date: event.evidence.paymentJournal.entryDate,
        memo: event.evidence.paymentJournal.memo,
        debitAccount: event.evidence.paymentJournal.debitAccount,
        creditAccount: event.evidence.paymentJournal.creditAccount,
      },
      feeJournal: event.evidence.feeJournal,
      proposedPayment: event.proposedPayment,
      proposedAllocation: event.proposedAllocation,
    }));

    console.log(
      JSON.stringify(
        {
          organizationId: orgId,
          organizationName: "name" in org ? org.name : undefined,
          ...result,
          events: reportEvents,
        },
        null,
        2,
      ),
    );
  }

  if (!apply) {
    console.error(
      "\nDry run only. Re-run with APPLY=1 to insert reconstructed payment subledger rows.",
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
