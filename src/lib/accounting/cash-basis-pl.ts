import { asNumber } from "@/lib/format";
import { roundMoney } from "./payment-fees";
import { inReportDateRange } from "./report-context";
import type { AccountRow, PLAccountLine, ProfitAndLoss } from "./reports";
import { buildProfitAndLoss } from "./reports";

export type CashBasisDocumentLine = {
  account_id: string | null;
  amount: number | string;
  line_type?: string | null;
};

export type CashBasisDocument = {
  id: string;
  kind: string;
  status: string;
  total: number | string;
  issue_date: string;
  posted_entry_id?: string | null;
  lines: CashBasisDocumentLine[];
};

export type CashBasisPayment = {
  id: string;
  payment_date: string;
  payment_type: string;
  payment_method?: string | null;
  status?: string;
  amount: number | string;
};

export type CashBasisAllocation = {
  payment_id: string;
  document_id: string;
  amount: number | string;
  allocation_kind: string;
  reversed_by_allocation_id?: string | null;
  reversal_of_allocation_id?: string | null;
};

export type CashBasisSettlement = {
  date: string;
  accountId: string;
  amount: number;
  kind: "revenue" | "cogs" | "expense" | "refund_revenue" | "refund_expense";
};

const NON_CASH_EXPENSE_SOURCE_KINDS = new Set([
  "fixed-asset-depreciation",
  "depreciation",
  "invoice-writeoff",
  "adjustment",
  "fixed-asset-acquisition",
  "fixed-asset-disposal",
]);

const CREDIT_CARD_SUBTYPES = new Set(["credit_card", "credit card"]);

export function allocateProportionalAmounts(
  lineAmounts: number[],
  totalToAllocate: number,
): number[] {
  if (lineAmounts.length === 0) return [];
  const docTotal = lineAmounts.reduce((sum, n) => sum + n, 0);
  if (docTotal <= 0.009 || totalToAllocate <= 0.009) {
    return lineAmounts.map(() => 0);
  }

  const raw = lineAmounts.map((amt) => (amt / docTotal) * totalToAllocate);
  const rounded = raw.map((v) => roundMoney(v));
  const diff = roundMoney(totalToAllocate - rounded.reduce((s, n) => s + n, 0));
  if (Math.abs(diff) >= 0.005) {
    let maxIdx = 0;
    for (let i = 1; i < lineAmounts.length; i += 1) {
      if (lineAmounts[i]! > lineAmounts[maxIdx]!) maxIdx = i;
    }
    rounded[maxIdx] = roundMoney((rounded[maxIdx] ?? 0) + diff);
  }
  return rounded;
}

function accountTypeForLine(
  account: AccountRow | undefined,
  lineType?: string | null,
): "revenue" | "cogs" | "expense" | null {
  if (!account) return null;
  if (account.type === "revenue") return "revenue";
  if (account.type === "cogs") return "cogs";
  if (account.type === "expense") return "expense";
  if (lineType === "cogs") return "cogs";
  if (lineType === "revenue") return "revenue";
  return account.type === "expense" || account.type === "cogs" ? account.type : null;
}

function isActiveAllocation(row: CashBasisAllocation): boolean {
  return !row.reversed_by_allocation_id && !row.reversal_of_allocation_id;
}

function paymentById(payments: CashBasisPayment[]): Map<string, CashBasisPayment> {
  return new Map(payments.filter((p) => p.status !== "void").map((p) => [p.id, p]));
}

function documentsById(docs: CashBasisDocument[]): Map<string, CashBasisDocument> {
  return new Map(docs.map((d) => [d.id, d]));
}

function addSettlement(
  settlements: CashBasisSettlement[],
  date: string,
  accountId: string,
  amount: number,
  kind: CashBasisSettlement["kind"],
) {
  if (Math.abs(amount) < 0.005) return;
  settlements.push({ date, accountId, amount, kind });
}

function recognizeDocumentCashExpense(
  doc: CashBasisDocument,
  accounts: AccountRow[],
  accountMap: Map<string, AccountRow>,
  creditAccountId: string | null,
  settlements: CashBasisSettlement[],
) {
  const creditAccount = creditAccountId ? accountMap.get(creditAccountId) : undefined;
  const isCash =
    creditAccount?.subtype === "bank" || creditAccount?.code === "1000";
  const isCreditCard =
    creditAccount && CREDIT_CARD_SUBTYPES.has(creditAccount.subtype ?? "");
  if (!isCash && !isCreditCard) return;

  const lineAmounts = doc.lines.map((l) => asNumber(l.amount));
  const allocated = allocateProportionalAmounts(lineAmounts, asNumber(doc.total));
  for (let i = 0; i < doc.lines.length; i += 1) {
    const line = doc.lines[i]!;
    const account = line.account_id ? accountMap.get(line.account_id) : undefined;
    const plType = accountTypeForLine(account, line.line_type);
    if (!plType || plType === "revenue") continue;
    const accountId = line.account_id ?? account?.id;
    if (!accountId) continue;
    addSettlement(
      settlements,
      doc.issue_date,
      accountId,
      allocated[i] ?? 0,
      plType,
    );
  }
}

export function buildCashBasisSettlements(input: {
  documents: CashBasisDocument[];
  payments: CashBasisPayment[];
  allocations: CashBasisAllocation[];
  accounts: AccountRow[];
  /** Journal entries to exclude non-cash items — keyed by document posted_entry source kinds if available */
  excludedSourceKinds?: Set<string>;
  /** For paid-at-posting expenses: map documentId -> credit account used in posting */
  documentCreditAccountId?: Map<string, string>;
}): CashBasisSettlement[] {
  const settlements: CashBasisSettlement[] = [];
  const accountMap = new Map(input.accounts.map((a) => [a.id, a]));
  const docMap = documentsById(input.documents);
  const payMap = paymentById(input.payments);

  for (const alloc of input.allocations.filter(isActiveAllocation)) {
    const payment = payMap.get(alloc.payment_id);
    const doc = docMap.get(alloc.document_id);
    if (!payment || !doc) continue;

    const amount = asNumber(alloc.amount);
    const date = payment.payment_date.slice(0, 10);

    if (alloc.allocation_kind === "invoice_payment" || alloc.allocation_kind === "deposit_apply") {
      if (doc.kind !== "invoice") continue;
      const lineAmounts = doc.lines.map((l) => asNumber(l.amount));
      const parts = allocateProportionalAmounts(lineAmounts, amount);
      for (let i = 0; i < doc.lines.length; i += 1) {
        const line = doc.lines[i]!;
        const account = line.account_id ? accountMap.get(line.account_id) : undefined;
        if (!line.account_id || account?.type !== "revenue") continue;
        addSettlement(settlements, date, line.account_id, parts[i] ?? 0, "revenue");
      }
    }

    if (alloc.allocation_kind === "bill_payment") {
      if (doc.kind !== "bill" && doc.kind !== "expense") continue;
      const lineAmounts = doc.lines.map((l) => asNumber(l.amount));
      const parts = allocateProportionalAmounts(lineAmounts, amount);
      for (let i = 0; i < doc.lines.length; i += 1) {
        const line = doc.lines[i]!;
        const account = line.account_id ? accountMap.get(line.account_id) : undefined;
        const plType = accountTypeForLine(account, line.line_type);
        if (!plType || plType === "revenue" || !line.account_id) continue;
        addSettlement(settlements, date, line.account_id, parts[i] ?? 0, plType);
      }
    }

    if (alloc.allocation_kind === "credit_apply" || alloc.allocation_kind === "vendor_credit_apply") {
      // Credits reduce cash recognition at application — handled via reduced payment allocations
      continue;
    }
  }

  for (const payment of input.payments) {
    if (payment.status === "void") continue;
    const date = payment.payment_date.slice(0, 10);
    const amount = asNumber(payment.amount);

    if (payment.payment_type === "customer_refund") {
      addSettlement(settlements, date, "cash-revenue-refund", -amount, "refund_revenue");
    }
    if (payment.payment_type === "vendor_refund") {
      addSettlement(settlements, date, "cash-expense-refund", -amount, "refund_expense");
    }
  }

  for (const doc of input.documents) {
    if (!doc.posted_entry_id) continue;
    if (doc.kind === "expense" && doc.status === "paid") {
      const creditId = input.documentCreditAccountId?.get(doc.id) ?? null;
      recognizeDocumentCashExpense(doc, input.accounts, accountMap, creditId, settlements);
    }
  }

  void input.excludedSourceKinds;
  return settlements;
}

export function buildCashBasisProfitAndLoss(
  settlements: CashBasisSettlement[],
  accounts: AccountRow[],
  startDate: string | null,
  endDate: string | null,
): ProfitAndLoss {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const totals = new Map<string, { code: string; name: string; type: string; amount: number }>();

  for (const s of settlements) {
    if (!inReportDateRange(s.date, startDate, endDate)) continue;

    if (s.accountId === "cash-revenue-refund") {
      const current = totals.get("cash-refund-rev") ?? {
        code: "4099",
        name: "Customer refunds (cash basis)",
        type: "revenue",
        amount: 0,
      };
      current.amount += s.amount;
      totals.set("cash-refund-rev", current);
      continue;
    }
    if (s.accountId === "cash-expense-refund") {
      const current = totals.get("cash-refund-exp") ?? {
        code: "6199",
        name: "Vendor refunds (cash basis)",
        type: "expense",
        amount: 0,
      };
      current.amount += s.amount;
      totals.set("cash-refund-exp", current);
      continue;
    }

    const account = accountMap.get(s.accountId);
    if (!account) continue;
    const plType =
      s.kind === "revenue" || s.kind === "refund_revenue"
        ? "revenue"
        : s.kind === "cogs"
          ? "cogs"
          : "expense";

    const signed =
      plType === "revenue" ? s.amount : s.kind === "refund_expense" ? s.amount : s.amount;

    const current = totals.get(account.id) ?? {
      code: account.code,
      name: account.name,
      type: plType,
      amount: 0,
    };
    current.amount += signed;
    totals.set(account.id, current);
  }

  const revenue = [...totals.values()]
    .filter((r) => r.type === "revenue" && Math.abs(r.amount) >= 0.005)
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((r) => ({ code: r.code, name: r.name, amount: roundMoney(r.amount) }));

  const cogs = [...totals.values()]
    .filter((r) => r.type === "cogs" && Math.abs(r.amount) >= 0.005)
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((r) => ({ code: r.code, name: r.name, amount: roundMoney(r.amount) }));

  const expenses = [...totals.values()]
    .filter((r) => r.type === "expense" && Math.abs(r.amount) >= 0.005)
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((r) => ({ code: r.code, name: r.name, amount: roundMoney(r.amount) }));

  const totalRevenue = roundMoney(revenue.reduce((s, r) => s + r.amount, 0));
  const totalCogs = roundMoney(cogs.reduce((s, r) => s + r.amount, 0));
  const totalExpenses = roundMoney(expenses.reduce((s, r) => s + r.amount, 0));
  const grossProfit = roundMoney(totalRevenue - totalCogs);
  const netIncome = roundMoney(grossProfit - totalExpenses);

  return {
    revenue,
    cogs,
    expenses,
    totalRevenue,
    totalCogs,
    grossProfit,
    totalExpenses,
    netIncome,
  };
}

export function isNonCashPlSourceKind(sourceKind: string | null | undefined): boolean {
  if (!sourceKind) return false;
  return NON_CASH_EXPENSE_SOURCE_KINDS.has(sourceKind);
}

export { NON_CASH_EXPENSE_SOURCE_KINDS };
