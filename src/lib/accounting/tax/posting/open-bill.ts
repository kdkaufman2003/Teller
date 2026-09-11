import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { postBillOpen } from "../../bills";
import { loadOrgAccounts } from "../../post";
import type { TaxLocationInput } from "../types";
import type { PurchaseLineClassificationInput } from "../purchase/compare-vendor-tax";
import { buildUseTaxJournalLines } from "../purchase/use-tax-journal";
import {
  buildTaxCalculationInputFromDocument,
  type DocumentLineForTax,
} from "./document-input";
import { persistPostedPurchaseTaxBundle } from "./persist-purchase-tax";
import { preparePurchaseTaxPosting } from "./prepare-purchase";

export class PurchaseTaxPostingBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseTaxPostingBlockedError";
  }
}

export { PurchaseTaxPostingBlockedError as TaxPostingBlockedError };

function lineClassificationsFromDocument(
  lines: DocumentLineForTax[],
  accounts: Array<{ id: string; type: string }>,
): PurchaseLineClassificationInput[] {
  return lines.map((line, index) => {
    const account = accounts.find((row) => row.id === line.account_id);
    return {
      lineKey: line.lineKey ?? line.id ?? String(index),
      accountType: account?.type ?? null,
      costType: line.cost_type ?? null,
      itemType: line.item_type ?? null,
    };
  });
}

export async function postBillOpenWithPhase15Tax(
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
  },
): Promise<{
  entryId: string;
  vendorTaxCharged: number;
  useTaxDueTotal: number;
  subtotal: number;
  total: number;
}> {
  const { data: currentDoc } = await supabase
    .from("teller_documents")
    .select("posted_entry_id, tax, subtotal, total")
    .eq("id", input.documentId)
    .maybeSingle();

  if (currentDoc?.posted_entry_id) {
    const { data: useTaxRows } = await supabase
      .from("teller_tax_transactions")
      .select("tax_amount")
      .eq("organization_id", input.organizationId)
      .eq("document_id", input.documentId)
      .eq("transaction_type", "use_tax_accrued")
      .eq("is_posted", true);
    const useTaxDueTotal = (useTaxRows ?? []).reduce(
      (sum, row) => sum + asNumber(row.tax_amount),
      0,
    );
    return {
      entryId: currentDoc.posted_entry_id as string,
      vendorTaxCharged: asNumber(currentDoc.tax),
      useTaxDueTotal,
      subtotal: asNumber(currentDoc.subtotal),
      total: asNumber(currentDoc.total),
    };
  }

  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const lineClassifications = lineClassificationsFromDocument(input.lines, accounts);

  const calculationInput = buildTaxCalculationInputFromDocument({
    transactionDate: input.issueDate,
    transactionType: "bill",
    location: input.location,
    lines: input.lines,
  });

  const prepared = await preparePurchaseTaxPosting(supabase, input.organizationId, {
    calculationInput,
    vendorTaxCharged: input.vendorTaxCharged,
    vendorTaxByLine: input.vendorTaxByLine,
    lineClassifications,
    sourceType: "bill",
    sourceId: input.documentId,
  });

  if (!prepared.canPost) {
    throw new PurchaseTaxPostingBlockedError(prepared.reason ?? "Purchase tax posting is blocked");
  }

  const subtotal = input.lines.reduce((sum, line) => sum + asNumber(line.amount), 0);
  const vendorTaxCharged = asNumber(input.vendorTaxCharged);
  const useTaxDueTotal = prepared.useTaxDueTotal;
  const total = subtotal + vendorTaxCharged;

  const useTaxJournalLines =
    useTaxDueTotal > 0.009 && prepared.salesTaxPayableAccountId
      ? buildUseTaxJournalLines({
          comparison: prepared.comparison,
          lineTargets: input.lines.map((line, index) => ({
            lineKey: line.lineKey ?? line.id ?? String(index),
            accountId: line.account_id ?? "",
            accountType: accounts.find((row) => row.id === line.account_id)?.type ?? null,
            costType: line.cost_type ?? null,
            jobId: line.job_id ?? input.jobId,
            costClassification: line.cost_classification ?? null,
          })),
          useTaxExpenseAccountId: prepared.useTaxExpenseAccountId,
          salesTaxPayableAccountId: prepared.salesTaxPayableAccountId,
          partyId: input.partyId,
          memo: `Use tax on bill ${input.number}`,
        })
      : [];

  const entryId = await postBillOpen(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    partyId: input.partyId,
    jobId: input.jobId,
    issueDate: input.issueDate,
    number: input.number,
    tax: vendorTaxCharged,
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
    additionalJournalLines: useTaxJournalLines,
  });

  const { data: postedLines } = await supabase
    .from("teller_document_lines")
    .select("id, sort_order")
    .eq("document_id", input.documentId)
    .order("sort_order");

  const calculationForPersist = {
    ...prepared.calculation,
    lineResults: prepared.calculation.lineResults.map((line, index) => ({
      ...line,
      lineId: postedLines?.[index]?.id ?? line.lineId ?? null,
    })),
  };
  const calculationInputForPersist = {
    ...calculationInput,
    lines: calculationInput.lines.map((line, index) => ({
      ...line,
      lineId: postedLines?.[index]?.id ?? line.lineId ?? null,
    })),
  };

  await persistPostedPurchaseTaxBundle(supabase, input.organizationId, {
    calculationInput: calculationInputForPersist,
    calculation: calculationForPersist,
    comparison: prepared.comparison,
    documentId: input.documentId,
    journalEntryId: entryId,
    vendorTaxCharged,
  });

  return { entryId, vendorTaxCharged, useTaxDueTotal, subtotal, total };
}
