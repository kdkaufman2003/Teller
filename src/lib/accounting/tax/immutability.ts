import type { TaxTransactionRecord } from "./types";

export const POSTED_TAX_HISTORY_IMMUTABLE = true;

export function assertTaxTransactionMutable(record: Pick<TaxTransactionRecord, "isPosted">): void {
  if (record.isPosted && POSTED_TAX_HISTORY_IMMUTABLE) {
    throw new Error("Posted tax transactions are immutable");
  }
}

export function canMutateTaxTransaction(record: Pick<TaxTransactionRecord, "isPosted">): boolean {
  return !record.isPosted;
}
