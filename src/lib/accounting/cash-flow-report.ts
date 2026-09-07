import { asNumber } from "@/lib/format";
import { roundMoney } from "./payment-fees";
import { accumulateAccountBalances } from "./financial-reports";
import { dayBefore, inReportDateRange } from "./report-context";
import type { AccountRow, JournalLineRow, ProfitAndLoss } from "./reports";

export type CashFlowCategory =
  | "operating"
  | "investing"
  | "financing"
  | "non_cash"
  | "transfer"
  | "unclassified";

export type CashFlowLine = {
  label: string;
  amount: number;
  category?: CashFlowCategory;
  accountCode?: string;
  entryId?: string;
};

export type CashFlowStatement = {
  operating: CashFlowLine[];
  investing: CashFlowLine[];
  financing: CashFlowLine[];
  unclassified: CashFlowLine[];
  netOperating: number;
  netInvesting: number;
  netFinancing: number;
  netUnclassified: number;
  netChangeInCash: number;
  beginningCash: number;
  endingCash: number;
  reconciled: boolean;
  usesAccrualNetIncome: boolean;
};

type DatedJournalLine = JournalLineRow & {
  entry_date: string;
  entry_id?: string;
  source_kind?: string | null;
};

type AccountWithCashFlow = AccountRow & {
  cash_flow_category?: string | null;
};

function isCashAccount(account: AccountRow): boolean {
  return account.subtype === "bank" || account.code === "1000";
}

function isCreditCardLiability(account: AccountRow): boolean {
  return (
    account.subtype === "credit_card" ||
    account.subtype === "credit card" ||
    account.name.toLowerCase().includes("credit card")
  );
}

function isReceivable(account: AccountRow): boolean {
  return account.subtype === "receivable" || account.code === "1100";
}

function isPayable(account: AccountRow): boolean {
  return account.subtype === "payable" || account.code === "2000";
}

function isDepositLiability(account: AccountRow): boolean {
  return account.subtype === "deposit";
}

function isDepreciationExpense(account: AccountRow, sourceKind?: string | null): boolean {
  if (account.subtype === "accumulated_depreciation") return false;
  const expenseSide =
    account.type === "expense" ||
    account.subtype === "depreciation" ||
    account.name.toLowerCase().includes("depreciation");
  if (!expenseSide) return false;
  if (sourceKind?.includes("depreciation")) return true;
  return account.subtype === "depreciation" || account.name.toLowerCase().includes("depreciation");
}

function isFixedAssetAccount(account: AccountRow): boolean {
  return account.subtype === "fixed_asset" || account.type === "asset" && account.code.startsWith("15");
}

function isOwnerEquityFlow(account: AccountRow): boolean {
  return (
    account.subtype === "owner_contribution" ||
    account.subtype === "owner_draw" ||
    account.name.toLowerCase().includes("owner") ||
    account.name.toLowerCase().includes("draw") ||
    account.name.toLowerCase().includes("distribution")
  );
}

export function classifyAccountCashFlow(
  account: AccountWithCashFlow,
  sourceKind?: string | null,
): CashFlowCategory {
  if (account.cash_flow_category) {
    return account.cash_flow_category as CashFlowCategory;
  }
  if (isCashAccount(account)) return "transfer";
  if (isCreditCardLiability(account)) return "operating";
  if (isReceivable(account) || isPayable(account) || isDepositLiability(account)) {
    return "operating";
  }
  if (isDepreciationExpense(account, sourceKind)) return "non_cash";
  if (isFixedAssetAccount(account)) return "investing";
  if (account.type === "equity" && isOwnerEquityFlow(account)) return "financing";
  if (account.subtype === "accumulated_depreciation") return "non_cash";
  return "unclassified";
}

function accountBalanceTotal(
  balances: Map<string, number>,
  accounts: AccountRow[],
  matcher: (account: AccountRow) => boolean,
): number {
  return roundMoney(
    accounts.filter(matcher).reduce((sum, account) => sum + (balances.get(account.id) ?? 0), 0),
  );
}

export function buildCashFlowStatement(input: {
  lines: DatedJournalLine[];
  accounts: AccountWithCashFlow[];
  startDate: string | null;
  endDate: string;
  accrualNetIncome: number;
  entrySourceKinds?: Map<string, string | null>;
  startBalances?: Map<string, number>;
  endBalances?: Map<string, number>;
  periodDepreciationAddBack?: number;
}): CashFlowStatement {
  const end = input.endDate.slice(0, 10);
  const start =
    input.startDate ??
    (input.lines.length
      ? [...input.lines].map((l) => l.entry_date).sort()[0]!
      : end);

  const startBalances =
    input.startBalances ?? accumulateAccountBalances(input.lines, input.accounts, dayBefore(start));
  const endBalances =
    input.endBalances ?? accumulateAccountBalances(input.lines, input.accounts, end);

  const beginningCash = accountBalanceTotal(startBalances, input.accounts, isCashAccount);
  const endingCash = accountBalanceTotal(endBalances, input.accounts, isCashAccount);

  const arStart = accountBalanceTotal(startBalances, input.accounts, isReceivable);
  const arEnd = accountBalanceTotal(endBalances, input.accounts, isReceivable);
  const apStart = accountBalanceTotal(startBalances, input.accounts, isPayable);
  const apEnd = accountBalanceTotal(endBalances, input.accounts, isPayable);
  const depStart = accountBalanceTotal(startBalances, input.accounts, isDepositLiability);
  const depEnd = accountBalanceTotal(endBalances, input.accounts, isDepositLiability);

  const operating: CashFlowLine[] = [
    { label: "Net income (accrual)", amount: roundMoney(input.accrualNetIncome) },
  ];

  const depreciationAddBack =
    input.periodDepreciationAddBack ??
    sumDepreciationInPeriod(
      input.lines,
      input.accounts,
      start,
      end,
      input.entrySourceKinds,
    );
  if (Math.abs(depreciationAddBack) >= 0.005) {
    operating.push({
      label: "Depreciation and amortization",
      amount: roundMoney(depreciationAddBack),
      category: "operating",
    });
  }

  const deltaAr = roundMoney(arEnd - arStart);
  const deltaAp = roundMoney(apEnd - apStart);
  const deltaDep = roundMoney(depEnd - depStart);

  if (Math.abs(deltaAr) >= 0.005) {
    operating.push({
      label: "Change in accounts receivable",
      amount: roundMoney(-deltaAr),
      category: "operating",
    });
  }
  if (Math.abs(deltaAp) >= 0.005) {
    operating.push({
      label: "Change in accounts payable",
      amount: deltaAp,
      category: "operating",
    });
  }
  if (Math.abs(deltaDep) >= 0.005) {
    operating.push({
      label: "Change in customer deposits",
      amount: roundMoney(-deltaDep),
      category: "operating",
    });
  }

  const investing: CashFlowLine[] = [];
  const financing: CashFlowLine[] = [];
  const unclassified: CashFlowLine[] = [];

  const cashMovements = classifyCashJournalMovements({
    lines: input.lines,
    accounts: input.accounts,
    startDate: start,
    endDate: end,
    entrySourceKinds: input.entrySourceKinds,
  });

  for (const mv of cashMovements) {
    if (mv.category === "investing") investing.push(mv);
    else if (mv.category === "financing") financing.push(mv);
    else if (mv.category === "transfer") {
      // Transfers net to zero in consolidated cash — skip from sections
    } else if (mv.category === "unclassified") unclassified.push(mv);
  }

  const netOperating = roundMoney(operating.reduce((s, r) => s + r.amount, 0));
  const netInvesting = roundMoney(investing.reduce((s, r) => s + r.amount, 0));
  const netFinancing = roundMoney(financing.reduce((s, r) => s + r.amount, 0));
  const netUnclassified = roundMoney(unclassified.reduce((s, r) => s + r.amount, 0));
  const netChangeInCash = roundMoney(endingCash - beginningCash);
  const computedChange = roundMoney(netOperating + netInvesting + netFinancing + netUnclassified);
  const reconciled = Math.abs(netChangeInCash - computedChange) < 0.05;

  if (!reconciled && Math.abs(netChangeInCash - computedChange) >= 0.05) {
    const gap = roundMoney(netChangeInCash - computedChange);
    unclassified.push({
      label: "Unclassified cash flow activity (reconciliation)",
      amount: gap,
      category: "unclassified",
    });
  }

  const finalUnclassified = roundMoney(
    unclassified.reduce((s, r) => s + r.amount, 0),
  );

  return {
    operating,
    investing,
    financing,
    unclassified,
    netOperating,
    netInvesting,
    netFinancing,
    netUnclassified: finalUnclassified,
    netChangeInCash,
    beginningCash,
    endingCash,
    reconciled: Math.abs(netChangeInCash - (netOperating + netInvesting + netFinancing + finalUnclassified)) < 0.05,
    usesAccrualNetIncome: true,
  };
}

function sumDepreciationInPeriod(
  lines: DatedJournalLine[],
  accounts: AccountRow[],
  start: string,
  end: string,
  entrySourceKinds?: Map<string, string | null>,
): number {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  let total = 0;
  for (const line of lines) {
    if (!inReportDateRange(line.entry_date, start, end)) continue;
    const account = accountMap.get(line.account_id);
    if (!account) continue;
    const sourceKind = line.entry_id ? entrySourceKinds?.get(line.entry_id) : line.source_kind;
    if (!isDepreciationExpense(account, sourceKind ?? null)) continue;
    total += asNumber(line.debit) - asNumber(line.credit);
  }
  return roundMoney(total);
}

function classifyCashJournalMovements(input: {
  lines: DatedJournalLine[];
  accounts: AccountWithCashFlow[];
  startDate: string;
  endDate: string;
  entrySourceKinds?: Map<string, string | null>;
}): CashFlowLine[] {
  const accountMap = new Map(input.accounts.map((a) => [a.id, a]));
  const cashIds = new Set(input.accounts.filter(isCashAccount).map((a) => a.id));

  const entriesInPeriod = new Map<string, DatedJournalLine[]>();
  for (const line of input.lines) {
    if (!inReportDateRange(line.entry_date, input.startDate, input.endDate)) continue;
    const entryId = line.entry_id ?? "unknown";
    const bucket = entriesInPeriod.get(entryId) ?? [];
    bucket.push(line);
    entriesInPeriod.set(entryId, bucket);
  }

  const results: CashFlowLine[] = [];

  for (const [entryId, entryLines] of entriesInPeriod) {
    const cashDelta = roundMoney(
      entryLines
        .filter((l) => cashIds.has(l.account_id))
        .reduce((s, l) => s + asNumber(l.debit) - asNumber(l.credit), 0),
    );
    if (Math.abs(cashDelta) < 0.005) continue;

    const counterpartLines = entryLines.filter((l) => !cashIds.has(l.account_id));
    if (counterpartLines.length === 0) continue;

    const sourceKind = input.entrySourceKinds?.get(entryId) ?? entryLines[0]?.source_kind ?? null;

    let category: CashFlowCategory = "unclassified";
    for (const cl of counterpartLines) {
      const account = accountMap.get(cl.account_id);
      if (!account) continue;
      const cat = classifyAccountCashFlow(account, sourceKind);
      if (cat === "investing" || cat === "financing") {
        category = cat;
        break;
      }
      if (cat === "operating") {
        category = cat;
        break;
      }
    }

    if (counterpartLines.every((cl) => cashIds.has(cl.account_id))) {
      category = "transfer";
      continue;
    }

    const primaryAccount = accountMap.get(counterpartLines[0]!.account_id);
    results.push({
      label: primaryAccount
        ? `${primaryAccount.code} ${primaryAccount.name}`
        : "Cash movement",
      amount: cashDelta,
      category,
      accountCode: primaryAccount?.code,
      entryId,
    });
  }

  return results;
}
