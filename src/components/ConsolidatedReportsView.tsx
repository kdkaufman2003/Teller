"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { money } from "@/lib/format";
import type {
  ConsolidatedBalanceSheetReport,
  ConsolidatedCashFlowReport,
  ConsolidatedProfitAndLossReport,
  ConsolidatedTrialBalanceReport,
} from "@/lib/accounting/consolidated/types";
import type { ActiveLegalEntitySummary } from "@/types";

type ReportTab = "trial_balance" | "profit_loss" | "balance_sheet" | "cash_flow";

const TABS: { id: ReportTab; label: string }[] = [
  { id: "trial_balance", label: "Trial balance" },
  { id: "profit_loss", label: "Profit & loss" },
  { id: "balance_sheet", label: "Balance sheet" },
  { id: "cash_flow", label: "Cash flow" },
];

function ContributionRows({
  contributions,
}: {
  contributions: Array<{ entityName: string; amount: number }>;
}) {
  if (!contributions.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 pl-4 text-xs text-muted">
      {contributions.map((row) => (
        <li key={row.entityName}>
          {row.entityName}: {money(row.amount)}
        </li>
      ))}
    </ul>
  );
}

export function ConsolidatedReportsView({
  accessibleEntities,
  periodStart,
  periodEnd,
  asOf,
  tab,
  includeAll,
  selectedEntityIds,
  trialBalance,
  profitAndLoss,
  balanceSheet,
  cashFlow,
  error,
}: {
  accessibleEntities: ActiveLegalEntitySummary[];
  periodStart: string;
  periodEnd: string;
  asOf: string;
  tab: ReportTab;
  includeAll: boolean;
  selectedEntityIds: string[];
  trialBalance: ConsolidatedTrialBalanceReport | null;
  profitAndLoss: ConsolidatedProfitAndLossReport | null;
  balanceSheet: ConsolidatedBalanceSheetReport | null;
  cashFlow: ConsolidatedCashFlowReport | null;
  error?: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [expanded, setExpanded] = useState<string | null>(null);

  const meta =
    trialBalance ?? profitAndLoss ?? balanceSheet ?? cashFlow ?? null;

  const scopeOptions = useMemo(
    () => [
      { id: "all", label: "All Companies" },
      ...accessibleEntities.map((entity) => ({
        id: entity.id,
        label: entity.name,
      })),
    ],
    [accessibleEntities],
  );

  function pushParams(next: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      params.set(key, value);
    }
    router.push(`?${params.toString()}`);
  }

  function onScopeChange(value: string) {
    if (value === "all") {
      pushParams({ scope: "all", entityIds: "" });
      return;
    }
    pushParams({ scope: "selected", entityIds: value });
  }

  const currentScopeValue = includeAll ? "all" : selectedEntityIds[0] ?? "all";

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <p className="font-medium">Pre-elimination consolidated reporting</p>
        <p className="mt-1 text-amber-900/80">
          Intercompany due-to and due-from balances remain visible. Elimination entries are handled in a future phase.
        </p>
      </div>

      {meta?.intercompanyWarnings?.length ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-950">
          {meta.intercompanyWarnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="text-sm text-muted" htmlFor="consolidated-scope">
            Companies
          </label>
          <select
            id="consolidated-scope"
            className="mt-1 block rounded-md border border-rule bg-paper-strong px-3 py-2 text-sm"
            value={currentScopeValue}
            onChange={(event) => onScopeChange(event.target.value)}
          >
            {scopeOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.id === "all" ? "Consolidated — All Companies" : option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm text-muted" htmlFor="period-start">
            Period start
          </label>
          <input
            id="period-start"
            type="date"
            className="mt-1 block rounded-md border border-rule bg-paper-strong px-3 py-2 text-sm"
            value={periodStart}
            onChange={(event) => pushParams({ periodStart: event.target.value })}
          />
        </div>
        <div>
          <label className="text-sm text-muted" htmlFor="period-end">
            Period end / as-of
          </label>
          <input
            id="period-end"
            type="date"
            className="mt-1 block rounded-md border border-rule bg-paper-strong px-3 py-2 text-sm"
            value={periodEnd}
            onChange={(event) => pushParams({ periodEnd: event.target.value, asOf: event.target.value })}
          />
        </div>
      </div>

      {meta ? (
        <div className="text-sm text-muted">
          <p>
            Scope: <span className="text-ink">{meta.scope.scopeLabel}</span> ·{" "}
            {meta.preEliminationLabel} · {meta.scope.currency}
          </p>
          <p className="mt-1">
            Period status:{" "}
            {meta.periodStatuses
              .map((row) => `${row.entityName} (${row.status === "open" ? "open" : "closed"})`)
              .join(" · ")}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1 rounded-lg border border-rule bg-paper-strong p-1">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => pushParams({ tab: item.id })}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === item.id ? "bg-navy text-white" : "text-muted hover:text-ink"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      ) : null}

      {tab === "trial_balance" && trialBalance ? (
        <section className="space-y-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rule text-left text-muted">
                <th className="py-2">Account</th>
                <th className="py-2 text-right">Debit</th>
                <th className="py-2 text-right">Credit</th>
                <th className="py-2 text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {trialBalance.rows.map((row) => (
                <tr key={row.groupKey} className="border-b border-rule/60 align-top">
                  <td className="py-2">
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() =>
                        setExpanded(expanded === row.groupKey ? null : row.groupKey)
                      }
                    >
                      {row.code} {row.name}
                      {row.isIntercompany ? " (intercompany)" : ""}
                    </button>
                    {expanded === row.groupKey ? (
                      <ContributionRows contributions={row.entityContributions} />
                    ) : null}
                  </td>
                  <td className="py-2 text-right font-ledger">{money(row.adjustedDebit)}</td>
                  <td className="py-2 text-right font-ledger">{money(row.adjustedCredit)}</td>
                  <td className="py-2 text-right font-ledger">{money(row.netBalance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-medium">
                <td className="py-2">Totals</td>
                <td className="py-2 text-right font-ledger">{money(trialBalance.totals.adjustedDebit)}</td>
                <td className="py-2 text-right font-ledger">{money(trialBalance.totals.adjustedCredit)}</td>
                <td className="py-2 text-right font-ledger">
                  {trialBalance.balanced ? "Balanced" : "Out of balance"}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>
      ) : null}

      {tab === "profit_loss" && profitAndLoss ? (
        <section className="space-y-4 text-sm">
          <FinancialSection title="Revenue" lines={profitAndLoss.revenue} expanded={expanded} setExpanded={setExpanded} />
          <p className="font-medium">Total revenue: {money(profitAndLoss.totalRevenue)}</p>
          <FinancialSection title="COGS" lines={profitAndLoss.cogs} expanded={expanded} setExpanded={setExpanded} />
          <p className="font-medium">Gross profit: {money(profitAndLoss.grossProfit)}</p>
          <FinancialSection title="Operating expenses" lines={profitAndLoss.expenses} expanded={expanded} setExpanded={setExpanded} />
          <p className="font-medium">Net income: {money(profitAndLoss.netIncome)}</p>
          <div>
            <p className="text-muted">Entity net income</p>
            <ContributionRows contributions={profitAndLoss.entityNetIncome} />
          </div>
        </section>
      ) : null}

      {tab === "balance_sheet" && balanceSheet ? (
        <section className="space-y-4 text-sm">
          <FinancialSection title="Assets" lines={balanceSheet.assets} expanded={expanded} setExpanded={setExpanded} />
          <p className="font-medium">Total assets: {money(balanceSheet.totalAssets)}</p>
          <p className="text-muted">Due from related entities (pre-elimination): {money(balanceSheet.intercompanyDueFromTotal)}</p>
          <FinancialSection title="Liabilities" lines={balanceSheet.liabilities} expanded={expanded} setExpanded={setExpanded} />
          <p className="font-medium">Total liabilities: {money(balanceSheet.totalLiabilities)}</p>
          <p className="text-muted">Due to related entities (pre-elimination): {money(balanceSheet.intercompanyDueToTotal)}</p>
          <FinancialSection title="Equity" lines={balanceSheet.equity} expanded={expanded} setExpanded={setExpanded} />
          <p className="font-medium">Total equity: {money(balanceSheet.totalEquity)}</p>
          <p>{balanceSheet.balanced ? "Balance sheet balances." : "Balance sheet out of balance."}</p>
        </section>
      ) : null}

      {tab === "cash_flow" && cashFlow ? (
        <section className="space-y-3 text-sm">
          {cashFlow.limitation ? (
            <p className="rounded-md border border-rule bg-paper-strong px-3 py-2 text-muted">
              {cashFlow.limitation}
            </p>
          ) : null}
          <p>Net operating: {money(cashFlow.netOperating)}</p>
          <p>Net investing: {money(cashFlow.netInvesting)}</p>
          <p>Net financing: {money(cashFlow.netFinancing)}</p>
          <p className="font-medium">Net change in cash: {money(cashFlow.netChangeInCash)}</p>
          <p>Beginning cash: {money(cashFlow.beginningCash)}</p>
          <p>Ending cash: {money(cashFlow.endingCash)}</p>
          <div>
            <p className="text-muted">Entity net change</p>
            <ContributionRows contributions={cashFlow.entityNetChange} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

function FinancialSection({
  title,
  lines,
  expanded,
  setExpanded,
}: {
  title: string;
  lines: Array<{
    groupKey: string;
    code: string;
    name: string;
    amount: number;
    isIntercompany: boolean;
    entityContributions: Array<{ entityName: string; amount: number }>;
  }>;
  expanded: string | null;
  setExpanded: (key: string | null) => void;
}) {
  if (!lines.length) return null;
  return (
    <div>
      <h3 className="font-medium text-navy">{title}</h3>
      <ul className="mt-2 space-y-2">
        {lines.map((row) => (
          <li key={row.groupKey}>
            <button
              type="button"
              className="hover:underline"
              onClick={() => setExpanded(expanded === row.groupKey ? null : row.groupKey)}
            >
              {row.code} {row.name}: {money(row.amount)}
              {row.isIntercompany ? " (intercompany)" : ""}
            </button>
            {expanded === row.groupKey ? (
              <ContributionRows contributions={row.entityContributions} />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
