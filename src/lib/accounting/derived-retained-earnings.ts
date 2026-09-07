import type { AccountRow, JournalLineRow } from "./reports";
import { buildProfitAndLoss } from "./reports";
import { fiscalYearStartDate, parseFiscalYearStart } from "@/lib/org/config";
import { roundMoney } from "./payment-fees";
import { asNumber } from "@/lib/format";
import type { GlAccountTotalRow } from "./gl-account-totals";
import {
  cumulativeBalanceFromTotals,
  netIncomeFromTotals,
} from "./gl-account-totals";

type DatedJournalLine = JournalLineRow & { entry_date: string; account_id: string };

export type DerivedRetainedEarningsPresentation = {
  asOfDate: string;
  fiscalYearStartMonth: number;
  fiscalYearStart: string;
  retainedEarningsGlBalance: number;
  priorPeriodDerivedEarnings: number;
  currentFiscalYearEarnings: number;
  totalRetainedEarningsPresentation: number;
  /** @deprecated use totalRetainedEarningsPresentation */
  totalEquityFromEarnings: number;
};

function netIncomeThrough(
  lines: DatedJournalLine[],
  accounts: AccountRow[],
  throughDate: string,
): number {
  const scoped = lines.filter((line) => line.entry_date <= throughDate);
  return buildProfitAndLoss(scoped, accounts).netIncome;
}

export function computeDerivedRetainedEarningsFromTotals(input: {
  cumulativeTotals: GlAccountTotalRow[];
  priorTotals: GlAccountTotalRow[];
  accounts: AccountRow[];
  asOfDate: string;
  fiscalYearStartMonth: number;
}): DerivedRetainedEarningsPresentation {
  const asOfDate = input.asOfDate.slice(0, 10);
  const fiscalYearStartMonth = parseFiscalYearStart(input.fiscalYearStartMonth);
  const fyStart = fiscalYearStartDate(new Date(asOfDate + "T12:00:00"), fiscalYearStartMonth);
  const fiscalYearStart = fyStart.toISOString().slice(0, 10);

  const retainedAccount = input.accounts.find(
    (row) => row.type === "equity" && (row.code === "3100" || row.subtype === "retained_earnings"),
  );
  let retainedEarningsGlBalance = 0;
  if (retainedAccount) {
    const row = input.cumulativeTotals.find((item) => item.account_id === retainedAccount.id);
    if (row) {
      retainedEarningsGlBalance = cumulativeBalanceFromTotals(row, retainedAccount.type);
    }
  }

  const lifetimeThroughPrior = netIncomeFromTotals(input.priorTotals, input.accounts);
  const lifetimeThroughAsOf = netIncomeFromTotals(input.cumulativeTotals, input.accounts);
  const priorPeriodDerivedEarnings = roundMoney(lifetimeThroughPrior);
  const currentFiscalYearEarnings = roundMoney(lifetimeThroughAsOf - lifetimeThroughPrior);
  const totalRetainedEarningsPresentation = roundMoney(
    retainedEarningsGlBalance + priorPeriodDerivedEarnings + currentFiscalYearEarnings,
  );

  return {
    asOfDate,
    fiscalYearStartMonth,
    fiscalYearStart,
    retainedEarningsGlBalance,
    priorPeriodDerivedEarnings,
    currentFiscalYearEarnings,
    totalRetainedEarningsPresentation,
    totalEquityFromEarnings: totalRetainedEarningsPresentation,
  };
}

/**
 * Derived retained earnings presentation.
 *
 * Teller native model: no year-end closing journals. Components are additive:
 *   explicit RE GL balance + derived prior FY P&L + current FY P&L
 */
export function computeDerivedRetainedEarnings(input: {
  lines: DatedJournalLine[];
  accounts: AccountRow[];
  asOfDate: string;
  fiscalYearStartMonth: number;
}): DerivedRetainedEarningsPresentation {
  const asOfDate = input.asOfDate.slice(0, 10);
  const fiscalYearStartMonth = parseFiscalYearStart(input.fiscalYearStartMonth);
  const fyStart = fiscalYearStartDate(new Date(asOfDate + "T12:00:00"), fiscalYearStartMonth);
  const fiscalYearStart = fyStart.toISOString().slice(0, 10);

  const retainedAccount = input.accounts.find(
    (row) => row.type === "equity" && (row.code === "3100" || row.subtype === "retained_earnings"),
  );
  let retainedEarningsGlBalance = 0;
  if (retainedAccount) {
    for (const line of input.lines) {
      if (line.entry_date > asOfDate || line.account_id !== retainedAccount.id) continue;
      retainedEarningsGlBalance += asNumber(line.credit) - asNumber(line.debit);
    }
    retainedEarningsGlBalance = roundMoney(retainedEarningsGlBalance);
  }

  const dayBeforeFy = new Date(fyStart);
  dayBeforeFy.setDate(dayBeforeFy.getDate() - 1);
  const priorEnd = dayBeforeFy.toISOString().slice(0, 10);

  const lifetimeThroughPrior =
    priorEnd >= "1970-01-01" ? netIncomeThrough(input.lines, input.accounts, priorEnd) : 0;
  const lifetimeThroughAsOf = netIncomeThrough(input.lines, input.accounts, asOfDate);

  const priorPeriodDerivedEarnings = roundMoney(lifetimeThroughPrior);
  const currentFiscalYearEarnings = roundMoney(lifetimeThroughAsOf - lifetimeThroughPrior);
  const totalRetainedEarningsPresentation = roundMoney(
    retainedEarningsGlBalance + priorPeriodDerivedEarnings + currentFiscalYearEarnings,
  );

  return {
    asOfDate,
    fiscalYearStartMonth,
    fiscalYearStart,
    retainedEarningsGlBalance,
    priorPeriodDerivedEarnings,
    currentFiscalYearEarnings,
    totalRetainedEarningsPresentation,
    totalEquityFromEarnings: totalRetainedEarningsPresentation,
  };
}
