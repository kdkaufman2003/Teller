/**
 * Pure accounting semantics for Phase 4 review scenarios.
 * These functions mirror migration helper logic for unit-test proofs.
 */

export type PaymentAllocationRow = {
  id: string;
  amount: number;
  allocation_kind: string;
  reversal_of_allocation_id?: string | null;
  reversed_by_allocation_id?: string | null;
};

export type DocumentAllocationRow = {
  id: string;
  amount: number;
  allocation_kind: string;
  source_document_id: string;
  target_document_id: string;
  reversal_of_allocation_id?: string | null;
  reversed_by_allocation_id?: string | null;
};

const PAYMENT_KINDS = new Set([
  "invoice_payment",
  "bill_payment",
  "deposit_apply",
  "credit_apply",
  "vendor_credit_apply",
]);

export function isPaymentAllocationActive(row: PaymentAllocationRow, reversedOriginalIds: Set<string>): boolean {
  if (row.reversal_of_allocation_id) return false;
  if (reversedOriginalIds.has(row.id)) return false;
  return PAYMENT_KINDS.has(row.allocation_kind);
}

export function buildReversedOriginalIds(rows: PaymentAllocationRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.reversal_of_allocation_id) ids.add(row.reversal_of_allocation_id);
  }
  return ids;
}

export function activePaymentTotal(rows: PaymentAllocationRow[]): number {
  const reversed = buildReversedOriginalIds(rows);
  return round2(
    rows
      .filter((row) => isPaymentAllocationActive(row, reversed))
      .reduce((sum, row) => sum + row.amount, 0),
  );
}

export function isDocumentAllocationActive(row: DocumentAllocationRow, reversedOriginalIds: Set<string>): boolean {
  if (row.reversal_of_allocation_id) return false;
  if (reversedOriginalIds.has(row.id)) return false;
  return row.allocation_kind === "customer_credit_apply" || row.allocation_kind === "vendor_credit_apply";
}

export function buildDocumentReversedOriginalIds(rows: DocumentAllocationRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.reversal_of_allocation_id) ids.add(row.reversal_of_allocation_id);
  }
  return ids;
}

export function creditsAppliedFromSource(rows: DocumentAllocationRow[], sourceId: string): number {
  const reversed = buildDocumentReversedOriginalIds(rows);
  return round2(
    rows
      .filter((row) => row.source_document_id === sourceId && isDocumentAllocationActive(row, reversed))
      .reduce((sum, row) => sum + row.amount, 0),
  );
}

export function creditsAppliedToTarget(rows: DocumentAllocationRow[], targetId: string): number {
  const reversed = buildDocumentReversedOriginalIds(rows);
  return round2(
    rows
      .filter((row) => row.target_document_id === targetId && isDocumentAllocationActive(row, reversed))
      .reduce((sum, row) => sum + row.amount, 0),
  );
}

export function creditMemoAvailable(
  creditTotal: number,
  appliedFromSource: number,
  refunded: number,
): number {
  return round2(Math.max(0, creditTotal - appliedFromSource - refunded));
}

export function invoiceRemaining(
  total: number,
  cashPaid: number,
  creditsApplied: number,
  writeOffs: number,
): number {
  return round2(Math.max(0, total - cashPaid - creditsApplied - writeOffs));
}

export function depositAvailable(receipt: number, applied: number, refunded: number): number {
  return round2(Math.max(0, receipt - applied - refunded));
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Scenario B: $1,000 invoice paid, $250 credit memo + $250 credit refund — customer owes $0 */
export function scenarioSaleRefundNetAr(input: {
  invoiceTotal: number;
  payment: number;
  creditMemo: number;
  creditRefund: number;
}): {
  invoiceRemaining: number;
  netArGlEffect: number;
  availableCredit: number;
} {
  const cashPaid = input.payment;
  const creditsApplied = 0;
  const writeOffs = 0;
  const remaining = invoiceRemaining(input.invoiceTotal, cashPaid, creditsApplied, writeOffs);
  const creditAvailable = creditMemoAvailable(input.creditMemo, 0, input.creditRefund);
  // Credit memo Cr AR 250; refund Dr AR 250 Cr Cash 250 → net AR from credit lifecycle = 0
  const netArGlEffect = round2(input.creditMemo - input.creditRefund);
  return {
    invoiceRemaining: remaining,
    netArGlEffect,
    availableCredit: creditAvailable,
  };
}

/** Rejected pattern: invoice refund_offset without credit memo */
export function scenarioRejectedInvoiceRefund(input: {
  invoiceTotal: number;
  payment: number;
  invoiceRefund: number;
}): { invoiceRemaining: number; netArGlEffect: number } {
  const remaining = invoiceRemaining(input.invoiceTotal, input.payment - input.invoiceRefund, 0, 0);
  const netArGlEffect = input.invoiceRefund;
  return { invoiceRemaining: remaining, netArGlEffect };
}
