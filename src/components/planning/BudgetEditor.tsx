"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { money } from "@/lib/format";
import { fiscalYearCalendarMonths, monthLabel } from "@/lib/planning/budgets/periods";
import {
  accountAnnualTotal,
  budgetAnnualTotal,
  monthlyTotal,
} from "@/lib/planning/budgets/totals";
import { canEditBudgetLines } from "@/lib/planning/budgets/lifecycle";
import { planningOwnerLabel } from "@/lib/planning/presentation-labels";
import { routes } from "@/lib/routes";

type AccountRow = { id: string; code: string; name: string; type: string };
type VersionRow = {
  id: string;
  version_number: number;
  label: string;
  status: string;
};
type LineRow = { account_id: string; period_month: string; amount: number };

export function BudgetEditor({
  budgetId,
  budgetName,
  fiscalYear,
  versions,
  initialVersionId,
}: {
  budgetId: string;
  budgetName: string;
  fiscalYear: number;
  versions: VersionRow[];
  initialVersionId?: string;
}) {
  const router = useRouter();
  const months = useMemo(() => fiscalYearCalendarMonths(fiscalYear), [fiscalYear]);
  const [versionId, setVersionId] = useState(initialVersionId ?? versions[0]?.id ?? "");
  const [versionStatus, setVersionStatus] = useState(versions[0]?.status ?? "draft");
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [pending, setPending] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const editable = canEditBudgetLines(versionStatus as "draft");

  const cellKey = (accountId: string, periodMonth: string) => `${accountId}::${periodMonth}`;

  useEffect(() => {
    void Promise.all([
      fetch("/api/accounts").then((r) => r.json()),
      versionId
        ? fetch(`/api/planning/budgets/${budgetId}/versions/${versionId}`).then((r) => r.json())
        : Promise.resolve({ lines: [], version: null }),
    ]).then(([accountsData, versionData]) => {
      setAccounts((accountsData as { accounts?: AccountRow[] }).accounts ?? []);
      const lines = (versionData as { lines?: LineRow[] }).lines ?? [];
      const version = (versionData as { version?: { status?: string } }).version;
      if (version?.status) setVersionStatus(version.status);
      const next: Record<string, number> = {};
      for (const line of lines) {
        next[cellKey(line.account_id, line.period_month)] = Number(line.amount);
      }
      setAmounts(next);
    });
  }, [budgetId, versionId]);

  const linePayload = useMemo(() => {
    const lines: { accountId: string; periodMonth: string; amount: number }[] = [];
    for (const account of accounts) {
      for (const periodMonth of months) {
        const amount = amounts[cellKey(account.id, periodMonth)] ?? 0;
        if (amount !== 0) {
          lines.push({ accountId: account.id, periodMonth, amount });
        }
      }
    }
    return lines;
  }, [accounts, amounts, months]);

  const allLines = useMemo(
    () =>
      accounts.flatMap((account) =>
        months.map((periodMonth) => ({
          accountId: account.id,
          periodMonth,
          amount: amounts[cellKey(account.id, periodMonth)] ?? 0,
        })),
      ),
    [accounts, amounts, months],
  );

  async function save() {
    setPending("save");
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/planning/budgets/${budgetId}/versions/${versionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fiscalYear, lines: linePayload }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Save failed");
      setMessage(`Saved ${data.saved ?? linePayload.length} lines`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setPending("");
    }
  }

  async function lifecycle(action: string, label?: string) {
    setPending(action);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/planning/budgets/${budgetId}/versions/${versionId}/lifecycle`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, label }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Action failed");
      if (action === "clone" && data.version?.id) {
        router.push(`${routes.planningBudgets}/${budgetId}?version=${data.version.id}`);
        router.refresh();
        return;
      }
      if (data.version?.status) setVersionStatus(data.version.status);
      setMessage(`Version ${action} complete`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setPending("");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={routes.planningBudgets} className="text-sm text-muted-foreground hover:underline">
            ← Budgets
          </Link>
          <h1 className="text-2xl font-semibold">{budgetName}</h1>
          <p className="text-sm text-muted-foreground">
            FY{fiscalYear} · {planningOwnerLabel("Annual Plan")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {editable ? (
            <button
              type="button"
              disabled={!!pending}
              onClick={() => void save()}
              className="rounded-md bg-navy px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {pending === "save" ? "Saving…" : "Save plan"}
            </button>
          ) : null}
          {versionStatus === "draft" || versionStatus === "submitted" ? (
            <button
              type="button"
              disabled={!!pending}
              onClick={() => void lifecycle("approve")}
              className="rounded-md border px-4 py-2 text-sm"
            >
              Approve
            </button>
          ) : null}
          {versionStatus === "approved" ? (
            <button
              type="button"
              disabled={!!pending}
              onClick={() => void lifecycle("lock")}
              className="rounded-md border px-4 py-2 text-sm"
            >
              Lock
            </button>
          ) : null}
          {versionStatus === "approved" || versionStatus === "locked" ? (
            <button
              type="button"
              disabled={!!pending}
              onClick={() => void lifecycle("clone")}
              className="rounded-md border px-4 py-2 text-sm"
            >
              {planningOwnerLabel("Create Revision")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">
          Version{" "}
          <select
            value={versionId}
            onChange={(event) => {
              const next = versions.find((v) => v.id === event.target.value);
              setVersionId(event.target.value);
              if (next) setVersionStatus(next.status);
            }}
            className="ml-1 rounded border px-2 py-1"
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                v{version.version_number} · {version.label || version.status} ({version.status})
              </option>
            ))}
          </select>
        </label>
        <span className="rounded-full bg-muted px-3 py-1 text-xs uppercase tracking-wide">
          {versionStatus}
        </span>
      </div>

      {message ? <p className="text-sm text-green-700">{message}</p> : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      {!editable ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          This version is read-only. {planningOwnerLabel("Create Revision")} to make changes.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-rule">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="sticky left-0 z-10 bg-muted/30 px-3 py-2 text-left">Account</th>
              {months.map((periodMonth) => (
                <th key={periodMonth} className="px-2 py-2 text-right whitespace-nowrap">
                  {monthLabel(periodMonth)}
                </th>
              ))}
              <th className="px-3 py-2 text-right">Annual</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => {
              const accountLines = months.map((periodMonth) => ({
                accountId: account.id,
                periodMonth,
                amount: amounts[cellKey(account.id, periodMonth)] ?? 0,
              }));
              return (
                <tr key={account.id} className="border-b last:border-0">
                  <td className="sticky left-0 z-10 bg-paper-strong px-3 py-2">
                    <span className="font-medium">{account.code}</span>
                    <span className="ml-2 text-muted-foreground">{account.name}</span>
                  </td>
                  {months.map((periodMonth) => (
                    <td key={periodMonth} className="px-1 py-1">
                      <input
                        type="number"
                        step="0.01"
                        disabled={!editable || !!pending}
                        value={amounts[cellKey(account.id, periodMonth)] ?? ""}
                        onChange={(event) => {
                          const value = event.target.value;
                          setAmounts((prev) => ({
                            ...prev,
                            [cellKey(account.id, periodMonth)]: value === "" ? 0 : Number(value),
                          }));
                        }}
                        className="w-24 rounded border px-2 py-1 text-right disabled:bg-muted/40"
                      />
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-ledger">
                    {money(accountAnnualTotal(accountLines, account.id))}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t bg-muted/20 font-medium">
              <td className="sticky left-0 bg-muted/20 px-3 py-2">Monthly total</td>
              {months.map((periodMonth) => (
                <td key={periodMonth} className="px-3 py-2 text-right font-ledger">
                  {money(monthlyTotal(allLines, periodMonth))}
                </td>
              ))}
              <td className="px-3 py-2 text-right font-ledger">
                {money(budgetAnnualTotal(allLines))}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
