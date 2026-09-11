import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { postCreditMemoOpen } from "../../credits";
import { postInvoiceOpen } from "../../post";
import type { TaxLocationInput } from "../types";
import type { DocumentLineForTax } from "./document-input";
import { postBillOpenWithPhase15Tax } from "./open-bill";
import { postCreditMemoOpenWithPhase15Tax } from "./open-credit";
import { postInvoiceOpenWithPhase15Tax } from "./open-invoice";
import { isPhase15TaxPostingEnabled } from "./prepare";

export async function openInvoiceDocument(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    tax: number;
    location: TaxLocationInput;
    lines: DocumentLineForTax[];
    actorId?: string | null;
  },
) {
  if (await isPhase15TaxPostingEnabled(supabase, input.organizationId)) {
    return postInvoiceOpenWithPhase15Tax(supabase, input);
  }

  const entryId = await postInvoiceOpen(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    partyId: input.partyId,
    jobId: input.jobId,
    issueDate: input.issueDate,
    number: input.number,
    tax: input.tax,
    lines: input.lines.map((line) => ({
      amount: asNumber(line.amount),
      account_id: line.account_id ?? null,
      description: line.description ?? "",
      job_id: line.job_id ?? input.jobId,
      cost_classification: line.cost_classification ?? "",
    })),
  });

  const subtotal = input.lines.reduce((sum, line) => sum + asNumber(line.amount), 0);
  const tax = asNumber(input.tax);
  return { entryId, taxTotal: tax, subtotal, total: subtotal + tax };
}

export async function openCreditMemoDocument(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    tax: number;
    reason?: string;
    location: TaxLocationInput;
    lines: DocumentLineForTax[];
    originalDocumentId?: string | null;
    actorId?: string | null;
  },
) {
  if (await isPhase15TaxPostingEnabled(supabase, input.organizationId)) {
    return postCreditMemoOpenWithPhase15Tax(supabase, input);
  }

  const entryId = await postCreditMemoOpen(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    partyId: input.partyId,
    jobId: input.jobId,
    issueDate: input.issueDate,
    number: input.number,
    tax: input.tax,
    reason: input.reason,
    lines: input.lines.map((line) => ({
      amount: asNumber(line.amount),
      account_id: line.account_id ?? null,
      description: line.description ?? "",
    })),
    actorId: input.actorId,
  });

  const subtotal = input.lines.reduce((sum, line) => sum + asNumber(line.amount), 0);
  const tax = asNumber(input.tax);
  return { entryId, taxTotal: tax, subtotal, total: subtotal + tax };
}

export async function openBillDocument(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    vendorTaxCharged: number;
    vendorTaxByLine?: Record<string, number>;
    location: TaxLocationInput;
    lines: DocumentLineForTax[];
    actorId?: string | null;
    accrualAllocations?: Array<{ occurrenceId: string; appliedAmount: number }>;
    settlementIdempotencyKey?: string | null;
  },
) {
  if (input.accrualAllocations?.length) {
    const { postBillOpen } = await import("../../bills");
    const entryId = await postBillOpen(supabase, {
      organizationId: input.organizationId,
      documentId: input.documentId,
      partyId: input.partyId,
      jobId: input.jobId,
      issueDate: input.issueDate,
      number: input.number,
      tax: input.vendorTaxCharged,
      lines: input.lines.map((line) => ({
        amount: asNumber(line.amount),
        account_id: line.account_id ?? null,
        description: line.description ?? "",
        job_id: line.job_id ?? input.jobId,
        cost_category: line.cost_category ?? "",
        cost_type: line.cost_type ?? "",
        cost_classification: line.cost_classification ?? "direct",
      })),
      actorId: input.actorId,
      accrualAllocations: input.accrualAllocations,
      settlementIdempotencyKey: input.settlementIdempotencyKey,
    });
    const subtotal = input.lines.reduce((sum, line) => sum + asNumber(line.amount), 0);
    const vendorTax = asNumber(input.vendorTaxCharged);
    return { entryId, vendorTaxCharged: vendorTax, useTaxDueTotal: 0, subtotal, total: subtotal + vendorTax };
  }

  if (await isPhase15TaxPostingEnabled(supabase, input.organizationId)) {
    return postBillOpenWithPhase15Tax(supabase, input);
  }

  const { postBillOpen } = await import("../../bills");
  const entryId = await postBillOpen(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    partyId: input.partyId,
    jobId: input.jobId,
    issueDate: input.issueDate,
    number: input.number,
    tax: input.vendorTaxCharged,
    lines: input.lines.map((line) => ({
      amount: asNumber(line.amount),
      account_id: line.account_id ?? null,
      description: line.description ?? "",
      job_id: line.job_id ?? input.jobId,
      cost_category: line.cost_category ?? "",
      cost_type: line.cost_type ?? "",
      cost_classification: line.cost_classification ?? "direct",
    })),
    actorId: input.actorId,
  });
  const subtotal = input.lines.reduce((sum, line) => sum + asNumber(line.amount), 0);
  const vendorTax = asNumber(input.vendorTaxCharged);
  return { entryId, vendorTaxCharged: vendorTax, useTaxDueTotal: 0, subtotal, total: subtotal + vendorTax };
}
