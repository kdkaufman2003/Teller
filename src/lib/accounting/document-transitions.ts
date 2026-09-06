import { documentRemainingBalance } from "./balances";

export type InvoiceStatus = "draft" | "open" | "partially_paid" | "paid" | "void";
export type ExpenseStatus = "draft" | "open" | "partially_paid" | "paid" | "void";

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
