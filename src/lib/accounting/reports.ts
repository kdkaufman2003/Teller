import { asNumber } from "@/lib/format";

export type ReportPeriod = "month" | "quarter" | "ytd" | "all";

export type DateRange = {
  start: string | null;
  end: string | null;
  label: string;
};

export type AccountRow = {
  id: string;
  code: string;
  name: string;
  type: string;
};

export type JournalLineRow = {
  account_id: string;
  debit: number | string;
  credit: number | string;
};

export type PLAccountLine = {
  code: string;
  name: string;
  amount: number;
};

export type ProfitAndLoss = {
  revenue: PLAccountLine[];
  cogs: PLAccountLine[];
  expenses: PLAccountLine[];
  totalRevenue: number;
  totalCogs: number;
  grossProfit: number;
  totalExpenses: number;
  netIncome: number;
};

export type SalesMonthRow = {
  month: string;
  label: string;
  invoiced: number;
  collected: number;
};

export type SalesCustomerRow = {
  name: string;
  total: number;
  invoiceCount: number;
};

export type AccountingBasis = "cash" | "accrual";

export type SalesSummary = {
  /** Paid invoices — money received. */
  collected: number;
  /** Open posted invoices not yet paid. */
  awaitingPayment: number;
  /** Collected + awaiting (all posted invoice amounts). */
  postedTotal: number;
  /** @deprecated use awaitingPayment */
  open: number;
  /** @deprecated use postedTotal */
  invoiced: number;
  draft: number;
  paidCount: number;
  openCount: number;
  byMonth: SalesMonthRow[];
  topCustomers: SalesCustomerRow[];
};

export function reportPeriodRange(period: ReportPeriod, today = new Date()): DateRange {
  const year = today.getFullYear();
  const month = today.getMonth();
  const end = formatISO(today);

  if (period === "all") {
    return { start: null, end: null, label: "All time" };
  }

  if (period === "month") {
    const start = formatISO(new Date(year, month, 1));
    const label = today.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    return { start, end, label };
  }

  if (period === "quarter") {
    const quarterStartMonth = Math.floor(month / 3) * 3;
    const start = formatISO(new Date(year, quarterStartMonth, 1));
    const quarter = Math.floor(month / 3) + 1;
    return { start, end, label: `Q${quarter} ${year}` };
  }

  const start = `${year}-01-01`;
  return { start, end, label: `Year to date ${year}` };
}

function formatISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function plAmountForType(type: string, debit: number, credit: number): number {
  if (type === "revenue") return credit - debit;
  if (type === "cogs" || type === "expense") return debit - credit;
  return 0;
}

export function buildProfitAndLoss(
  lines: JournalLineRow[],
  accounts: AccountRow[],
): ProfitAndLoss {
  const accountMap = new Map(accounts.map((row) => [row.id, row]));
  const totals = new Map<string, { code: string; name: string; type: string; amount: number }>();

  for (const line of lines) {
    const account = accountMap.get(line.account_id);
    if (!account) continue;
    if (!["revenue", "cogs", "expense"].includes(account.type)) continue;

    const delta = plAmountForType(
      account.type,
      asNumber(line.debit),
      asNumber(line.credit),
    );
    if (Math.abs(delta) < 0.005) continue;

    const current = totals.get(account.id) ?? {
      code: account.code,
      name: account.name,
      type: account.type,
      amount: 0,
    };
    current.amount += delta;
    totals.set(account.id, current);
  }

  const revenue = sortLines(
    [...totals.values()].filter((row) => row.type === "revenue" && row.amount !== 0),
  );
  const cogs = sortLines(
    [...totals.values()].filter((row) => row.type === "cogs" && row.amount !== 0),
  );
  const expenses = sortLines(
    [...totals.values()].filter((row) => row.type === "expense" && row.amount !== 0),
  );

  const totalRevenue = roundMoney(revenue.reduce((sum, row) => sum + row.amount, 0));
  const totalCogs = roundMoney(cogs.reduce((sum, row) => sum + row.amount, 0));
  const totalExpenses = roundMoney(expenses.reduce((sum, row) => sum + row.amount, 0));
  const grossProfit = roundMoney(totalRevenue - totalCogs);
  const netIncome = roundMoney(grossProfit - totalExpenses);

  return {
    revenue: revenue.map(toPLLine),
    cogs: cogs.map(toPLLine),
    expenses: expenses.map(toPLLine),
    totalRevenue,
    totalCogs,
    grossProfit,
    totalExpenses,
    netIncome,
  };
}

function sortLines(rows: { code: string; name: string; amount: number }[]) {
  return rows.sort((a, b) => a.code.localeCompare(b.code));
}

function toPLLine(row: { code: string; name: string; amount: number }): PLAccountLine {
  return {
    code: row.code,
    name: row.name,
    amount: roundMoney(row.amount),
  };
}

/** Cash basis: revenue when paid; expenses/COGS still from posted journal lines. */
export function buildCashBasisProfitAndLoss(
  invoices: InvoiceRow[],
  lines: JournalLineRow[],
  accounts: AccountRow[],
  range: DateRange,
): ProfitAndLoss {
  const collectedRevenue = invoices
    .filter(
      (row) =>
        row.status === "paid" &&
        isBilledInvoice(row) &&
        inRange(row.issue_date, range),
    )
    .reduce((sum, row) => sum + asNumber(row.total), 0);

  const accrual = buildProfitAndLoss(lines, accounts);
  const totalRevenue = roundMoney(collectedRevenue);
  const grossProfit = roundMoney(totalRevenue - accrual.totalCogs);
  const netIncome = roundMoney(grossProfit - accrual.totalExpenses);

  return {
    revenue:
      totalRevenue > 0
        ? [{ code: "4000", name: "Cash collected (sales)", amount: totalRevenue }]
        : [],
    cogs: accrual.cogs,
    expenses: accrual.expenses,
    totalRevenue,
    totalCogs: accrual.totalCogs,
    grossProfit,
    totalExpenses: accrual.totalExpenses,
    netIncome,
  };
}

export function buildProfitAndLossForBasis(
  basis: AccountingBasis,
  invoices: InvoiceRow[],
  lines: JournalLineRow[],
  accounts: AccountRow[],
  range: DateRange,
): ProfitAndLoss {
  if (basis === "cash") {
    return buildCashBasisProfitAndLoss(invoices, lines, accounts, range);
  }
  return buildProfitAndLoss(lines, accounts);
}

export function parseAccountingBasis(value: unknown): AccountingBasis {
  return value === "cash" ? "cash" : "accrual";
}

type InvoiceRow = {
  status: string;
  total: number | string;
  amount_paid?: number | string;
  issue_date: string;
  party_id: string | null;
  posted_entry_id?: string | null;
};

/** Posted to the ledger (billed) — excludes drafts and voided pipeline invoices. */
export function isBilledInvoice(row: Pick<InvoiceRow, "status" | "posted_entry_id">): boolean {
  if (row.status === "void" || row.status === "draft") return false;
  if (row.status !== "open" && row.status !== "paid") return false;
  return Boolean(row.posted_entry_id);
}

export function buildSalesSummary(
  invoices: InvoiceRow[],
  partyNames: Map<string, string>,
  range: DateRange,
  basis: AccountingBasis = "accrual",
): SalesSummary {
  const filtered = invoices.filter((row) => inRange(row.issue_date, range));

  let collected = 0;
  let open = 0;
  let draft = 0;
  let paidCount = 0;
  let openCount = 0;

  const monthMap = new Map<string, SalesMonthRow>();
  const customerMap = new Map<string, { total: number; count: number }>();

  for (const row of filtered) {
    const total = asNumber(row.total);

    if (row.status === "draft") {
      draft += total;
      continue;
    }
    if (row.status === "void") continue;

    if (!isBilledInvoice(row)) continue;

    if (row.status === "paid") {
      collected += total;
      paidCount += 1;
    }
    if (row.status === "open") {
      open += total - asNumber(row.amount_paid);
      openCount += 1;
    }

    const salesAmount =
      basis === "cash"
        ? row.status === "paid"
          ? total
          : 0
        : total;

    const monthKey = row.issue_date.slice(0, 7);
    const monthRow = monthMap.get(monthKey) ?? {
      month: monthKey,
      label: monthLabel(monthKey),
      invoiced: 0,
      collected: 0,
    };
    if (basis === "accrual") {
      monthRow.invoiced += total;
    } else {
      monthRow.invoiced += salesAmount;
    }
    if (row.status === "paid") monthRow.collected += total;
    monthMap.set(monthKey, monthRow);

    if (row.party_id && salesAmount > 0) {
      const current = customerMap.get(row.party_id) ?? { total: 0, count: 0 };
      current.total += salesAmount;
      current.count += 1;
      customerMap.set(row.party_id, current);
    }
  }

  const postedTotal = roundMoney(collected + open);

  const byMonth = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));
  const topCustomers = [...customerMap.entries()]
    .map(([partyId, stats]) => ({
      name: partyNames.get(partyId) || "Unknown customer",
      total: roundMoney(stats.total),
      invoiceCount: stats.count,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  return {
    collected: roundMoney(collected),
    awaitingPayment: roundMoney(open),
    postedTotal,
    open: roundMoney(open),
    invoiced: postedTotal,
    draft: roundMoney(draft),
    paidCount,
    openCount,
    byMonth,
    topCustomers,
  };
}

function inRange(date: string, range: DateRange): boolean {
  if (!range.start && !range.end) return true;
  if (range.start && date < range.start) return false;
  if (range.end && date > range.end) return false;
  return true;
}

function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

export function parseReportPeriod(value: string | null | undefined): ReportPeriod {
  if (value === "month" || value === "quarter" || value === "ytd" || value === "all") {
    return value;
  }
  return "ytd";
}
