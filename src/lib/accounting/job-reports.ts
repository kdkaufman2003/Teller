import { asNumber } from "@/lib/format";
import type { AccountRow, JournalLineRow } from "./reports";

export type JobProfitability = {
  revenue: number;
  cogs: number;
  expenses: number;
  grossProfit: number;
  netJobProfit: number;
  revenueLines: { code: string; name: string; amount: number }[];
  cogsLines: { code: string; name: string; amount: number }[];
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function plAmountForType(type: string, debit: number, credit: number): number {
  if (type === "revenue") return credit - debit;
  if (type === "cogs" || type === "expense") return debit - credit;
  return 0;
}

/** Job P&L from posted journal lines tagged with job_id. */
export function buildJobProfitability(
  jobId: string,
  lines: (JournalLineRow & { job_id?: string | null })[],
  accounts: AccountRow[],
): JobProfitability {
  const accountMap = new Map(accounts.map((row) => [row.id, row]));
  const revenueLines: JobProfitability["revenueLines"] = [];
  const cogsLines: JobProfitability["cogsLines"] = [];
  let revenue = 0;
  let cogs = 0;
  let expenses = 0;

  for (const line of lines) {
    if (line.job_id !== jobId) continue;
    const account = accountMap.get(line.account_id);
    if (!account) continue;
    if (!["revenue", "cogs", "expense"].includes(account.type)) continue;

    const amount = plAmountForType(account.type, asNumber(line.debit), asNumber(line.credit));
    if (Math.abs(amount) < 0.005) continue;

    const row = { code: account.code, name: account.name, amount: roundMoney(amount) };
    if (account.type === "revenue") {
      revenue += amount;
      revenueLines.push(row);
    } else if (account.type === "cogs") {
      cogs += amount;
      cogsLines.push(row);
    } else {
      expenses += amount;
    }
  }

  revenue = roundMoney(revenue);
  cogs = roundMoney(cogs);
  expenses = roundMoney(expenses);
  const grossProfit = roundMoney(revenue - cogs);
  const netJobProfit = roundMoney(grossProfit - expenses);

  return {
    revenue,
    cogs,
    expenses,
    grossProfit,
    netJobProfit,
    revenueLines: revenueLines.sort((a, b) => a.code.localeCompare(b.code)),
    cogsLines: cogsLines.sort((a, b) => a.code.localeCompare(b.code)),
  };
}
