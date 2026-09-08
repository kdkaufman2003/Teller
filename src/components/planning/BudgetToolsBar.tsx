"use client";

import { useState } from "react";
import { fiscalYearCalendarMonths, monthLabel } from "@/lib/planning/budgets/periods";
import {
  applyMonthlyAmountsToAccount,
  applyPercentChange,
  clearAccountAmounts,
  copyMonthForward,
  spreadAnnualEvenly,
} from "@/lib/planning/budgets/budget-tools";

export function BudgetToolsBar({
  fiscalYear,
  accounts,
  amounts,
  setAmounts,
  cellKey,
  editable,
}: {
  fiscalYear: number;
  accounts: Array<{ id: string; code: string; name: string }>;
  amounts: Record<string, number>;
  setAmounts: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  cellKey: (accountId: string, periodMonth: string) => string;
  editable: boolean;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [sourceMonth, setSourceMonth] = useState(fiscalYearCalendarMonths(fiscalYear)[0] ?? "");
  const [annualAmount, setAnnualAmount] = useState("");
  const [percentChange, setPercentChange] = useState("");

  if (!editable || !accounts.length) return null;

  const months = fiscalYearCalendarMonths(fiscalYear);

  return (
    <div className="rounded-lg border border-rule bg-muted/20 p-4 text-sm">
      <p className="font-medium">Quick edits</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label>
          Account
          <select
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            className="ml-1 rounded border px-2 py-1"
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} {account.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Set annual
          <input
            type="number"
            step="0.01"
            value={annualAmount}
            onChange={(event) => setAnnualAmount(event.target.value)}
            className="ml-1 w-28 rounded border px-2 py-1"
            placeholder="12000"
          />
          <button
            type="button"
            onClick={() => {
              const total = Number(annualAmount);
              if (!Number.isFinite(total)) return;
              setAmounts((prev) =>
                applyMonthlyAmountsToAccount(
                  prev,
                  accountId,
                  fiscalYear,
                  spreadAnnualEvenly(total),
                  cellKey,
                ),
              );
            }}
            className="ml-1 rounded border px-2 py-1"
          >
            Spread evenly
          </button>
        </label>

        <label>
          From month
          <select
            value={sourceMonth}
            onChange={(event) => setSourceMonth(event.target.value)}
            className="ml-1 rounded border px-2 py-1"
          >
            {months.map((periodMonth) => (
              <option key={periodMonth} value={periodMonth}>
                {monthLabel(periodMonth)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() =>
              setAmounts((prev) => copyMonthForward(prev, accountId, sourceMonth, fiscalYear, cellKey))
            }
            className="ml-1 rounded border px-2 py-1"
          >
            Copy across
          </button>
        </label>

        <label>
          Adjust %
          <input
            type="number"
            step="0.1"
            value={percentChange}
            onChange={(event) => setPercentChange(event.target.value)}
            className="ml-1 w-20 rounded border px-2 py-1"
            placeholder="5"
          />
          <button
            type="button"
            onClick={() => {
              const pct = Number(percentChange);
              if (!Number.isFinite(pct)) return;
              setAmounts((prev) => applyPercentChange(prev, accountId, fiscalYear, pct, cellKey));
            }}
            className="ml-1 rounded border px-2 py-1"
          >
            Apply
          </button>
        </label>

        <button
          type="button"
          onClick={() => setAmounts((prev) => clearAccountAmounts(prev, accountId, fiscalYear, cellKey))}
          className="rounded border px-2 py-1 text-muted-foreground"
        >
          Clear account
        </button>
      </div>
    </div>
  );
}
