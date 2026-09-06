import { documentRemainingBalance } from "./balances";

export type InvoiceStatus = "draft" | "open" | "partially_paid" | "paid" | "void";
export type ExpenseStatus = "draft" | "open" | "partially_paid" | "paid" | "void";
export type BillStatus = "draft" | "pending_approval" | "open" | "partially_paid" | "paid" | "void";
export type CreditDocumentStatus =
  | "draft"
  | "open"
  | "partially_applied"
  | "applied"
  | "void";

const INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ["open", "void"],
  open: ["partially_paid", "paid", "void"],
  partially_paid: ["paid", "void"],
  paid: [],
  void: [],
};

const EXPENSE_TRANSITIONS: Record<ExpenseStatus, ExpenseStatus[]> = {
  draft: ["open", "paid", "void"],
  open: ["partially_paid", "paid", "void"],
  partially_paid: ["paid", "void"],
  paid: [],
  void: [],
};

export function invoiceStatusAfterPayment(
  documentTotal: number,
  amountPaid: number,
): "open" | "partially_paid" | "paid" {
  const remaining = documentRemainingBalance(documentTotal, amountPaid);
  if (remaining <= 0.009) return "paid";
  if (amountPaid > 0.009) return "partially_paid";
  return "open";
}

export function assertInvoiceStatusTransition(
  from: InvoiceStatus,
  to: InvoiceStatus,
  context?: { hasActivePayments?: boolean },
): void {
  if (from === to) return;

  const allowed = INVOICE_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid invoice status transition: ${from} → ${to}`);
  }

  if (to === "void" && context?.hasActivePayments) {
    throw new Error(
      "Cannot void an invoice with payment activity. Reverse or refund payments before voiding.",
    );
  }
}

export function assertExpenseStatusTransition(
  from: ExpenseStatus,
  to: ExpenseStatus,
  context?: { hasActivePayments?: boolean },
): void {
  if (from === to) return;

  const allowed = EXPENSE_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid expense status transition: ${from} → ${to}`);
  }

  if (to === "void" && context?.hasActivePayments) {
    throw new Error(
      "Cannot void an expense with payments recorded. Reverse payments first.",
    );
  }
}

export function canVoidInvoiceWithoutPayments(hasActivePayments: boolean): boolean {
  return !hasActivePayments;
}

const BILL_TRANSITIONS: Record<BillStatus, BillStatus[]> = {
  draft: ["pending_approval", "open", "void"],
  pending_approval: ["open", "draft", "void"],
  open: ["partially_paid", "paid", "void"],
  partially_paid: ["paid", "void"],
  paid: [],
  void: [],
};

const CREDIT_TRANSITIONS: Record<CreditDocumentStatus, CreditDocumentStatus[]> = {
  draft: ["open", "void"],
  open: ["partially_applied", "applied", "void"],
  partially_applied: ["applied", "void"],
  applied: [],
  void: [],
};

export function billStatusAfterPayment(
  documentTotal: number,
  amountPaid: number,
  creditsApplied = 0,
): BillStatus {
  const settled = amountPaid + creditsApplied;
  const remaining = documentRemainingBalance(documentTotal, settled);
  if (remaining <= 0.009) return "paid";
  if (settled > 0.009) return "partially_paid";
  return "open";
}

export function invoiceStatusAfterSettlement(
  documentTotal: number,
  amountPaid: number,
  creditsApplied = 0,
): InvoiceStatus {
  const settled = amountPaid + creditsApplied;
  const remaining = documentRemainingBalance(documentTotal, settled);
  if (remaining <= 0.009) return "paid";
  if (settled > 0.009) return "partially_paid";
  return "open";
}

export function creditDocumentStatusAfterApplication(
  documentTotal: number,
  amountApplied: number,
): CreditDocumentStatus {
  const remaining = documentRemainingBalance(documentTotal, amountApplied);
  if (remaining <= 0.009) return "applied";
  if (amountApplied > 0.009) return "partially_applied";
  return "open";
}

export function assertBillStatusTransition(from: BillStatus, to: BillStatus): void {
  if (from === to) return;
  const allowed = BILL_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid bill status transition: ${from} → ${to}`);
  }
}

export function assertCreditDocumentStatusTransition(
  from: CreditDocumentStatus,
  to: CreditDocumentStatus,
): void {
  if (from === to) return;
  const allowed = CREDIT_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid credit document status transition: ${from} → ${to}`);
  }
}
