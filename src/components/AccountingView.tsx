"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { money } from "@/lib/format";
import type { MonthPeriod, PeriodCloseRow } from "@/lib/accounting/periods";

type AccountOption = {
  id: string;
  code: string;
  name: string;
};

export function AccountingView({
  closedThrough,
  nextClose,
  periods,
  closes,
  accounts,
  canManageClose,
  canAdjust,
  canExport,
  cpaMode,
  role,
}: {
  closedThrough: string | null;
  nextClose: string | null;
  periods: MonthPeriod[];
  closes: PeriodCloseRow[];
  accounts: AccountOption[];
  canManageClose: boolean;
  canAdjust: boolean;
  canExport: boolean;
  cpaMode: boolean;
  role: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notes, setNotes] = useState("");
  const [adjustment, setAdjustment] = useState({
    entryDate: new Date().toISOString().slice(0, 10),
    memo: "",
    debitAccountId: accounts[0]?.id ?? "",
    creditAccountId: accounts[1]?.id ?? accounts[0]?.id ?? "",
    amount: "",
  });

  async function closePeriod() {
    if (!nextClose) return;
    setPending("close");
    setError("");
    try {
      const response = await fetch("/api/accounting/periods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodEnd: nextClose, notes }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not close period");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close period");
    } finally {
      setPending("");
    }
  }

  async function reopenPeriod(id: string) {
    setPending(`reopen-${id}`);
    setError("");
    try {
      const response = await fetch(`/api/accounting/periods?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not reopen period");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reopen period");
    } finally {
      setPending("");
    }
  }

  async function postAdjustment(event: React.FormEvent) {
    event.preventDefault();
    setPending("adjustment");
    setError("");
    const amount = Number(adjustment.amount);
    if (!amount || amount <= 0) {
      setError("Enter a positive adjustment amount.");
      setPending("");
      return;
    }

    try {
      const response = await fetch("/api/ledger/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryDate: adjustment.entryDate,
          memo: adjustment.memo,
          lines: [
            { account_id: adjustment.debitAccountId, debit: amount, credit: 0 },
            { account_id: adjustment.creditAccountId, debit: 0, credit: amount },
          ],
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not post adjustment");
      setAdjustment((current) => ({ ...current, memo: "", amount: "" }));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post adjustment");
    } finally {
      setPending("");
    }
  }

  function exportUrl(kind: string) {
    return `/api/exports?kind=${encodeURIComponent(kind)}`;
  }

  return (
    <div className="space-y-8">
      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {error}
        </p>
      ) : null}

      <section className="grid gap-3 md:grid-cols-3">
        <article className="card p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-muted">Books closed through</p>
          <p className="font-ledger mt-2 text-2xl text-navy">
            {closedThrough ? closedThrough : "Not closed"}
          </p>
          <p className="mt-1 text-xs text-muted">
            {closedThrough
              ? "New entries must be dated after this day."
              : "All posted dates are still open."}
          </p>
        </article>
        <article className="card p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-muted">CPA mode</p>
          <p className="font-ledger mt-2 text-2xl text-navy">{cpaMode ? "On" : "Off"}</p>
          <p className="mt-1 text-xs text-muted">
            {cpaMode
              ? "Viewers can export books for outside accountants."
              : "Enable in Settings for read-only accountant access."}
          </p>
        </article>
        <article className="card p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-muted">Your role</p>
          <p className="font-ledger mt-2 text-2xl capitalize text-navy">{role}</p>
          <p className="mt-1 text-xs text-muted">
            {canManageClose ? "You can close and reopen periods." : "Period close is owner/admin only."}
          </p>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <article className="card p-5">
          <h2 className="font-ledger text-2xl text-navy">Period close</h2>
          <p className="mt-1 text-sm text-muted">
            Close completed months in order to lock posted history.
          </p>

          {canManageClose && nextClose ? (
            <div className="mt-5 space-y-3 rounded-lg border border-rule bg-paper-strong p-4">
              <p className="text-sm">
                Next period to close: <strong>{nextClose}</strong>
              </p>
              <label className="block text-sm">
                <span className="text-muted">Notes (optional)</span>
                <input
                  className="mt-1 w-full rounded-md border border-rule bg-white px-3 py-2"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={pending === "close"}
                onClick={closePeriod}
                className="rounded-md bg-navy px-4 py-2 text-sm text-white disabled:opacity-60"
              >
                {pending === "close" ? "Closing…" : "Close period"}
              </button>
            </div>
          ) : (
            <p className="mt-5 text-sm text-muted">
              {canManageClose
                ? "No additional periods are ready to close yet."
                : "Ask an owner or admin to close the books."}
            </p>
          )}

          <table className="report-table mt-5">
            <thead>
              <tr>
                <th>Period</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {periods.map((period) => (
                <tr key={period.key}>
                  <td>{period.label}</td>
                  <td className="capitalize">{period.status}</td>
                  <td className="text-right">
                    {canManageClose &&
                    period.status === "closed" &&
                    closes[0]?.period_end === period.end ? (
                      <button
                        type="button"
                        className="text-sm text-sky"
                        disabled={Boolean(pending)}
                        onClick={() => reopenPeriod(closes[0]!.id)}
                      >
                        Reopen
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>

        <article className="card p-5">
          <h2 className="font-ledger text-2xl text-navy">Exports</h2>
          <p className="mt-1 text-sm text-muted">
            Download CSV files for accountants, tax prep, or migration.
          </p>

          {canExport ? (
            <div className="mt-5 flex flex-wrap gap-2">
              {[
                { kind: "journal", label: "General journal" },
                { kind: "trial_balance", label: "Trial balance" },
                { kind: "parties", label: "Customers & vendors" },
              ].map((item) => (
                <a
                  key={item.kind}
                  href={exportUrl(item.kind)}
                  className="rounded-md border border-rule bg-paper-strong px-4 py-2 text-sm hover:border-navy"
                >
                  {item.label}
                </a>
              ))}
            </div>
          ) : (
            <p className="mt-5 text-sm text-muted">
              Enable CPA mode in Settings to let viewer accounts export books.
            </p>
          )}
        </article>
      </section>

      {canAdjust ? (
        <article className="card p-5">
          <h2 className="font-ledger text-2xl text-navy">Manual adjustment</h2>
          <p className="mt-1 text-sm text-muted">
            Post a balanced two-line journal entry for year-end or correcting entries.
          </p>

          <form onSubmit={postAdjustment} className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="block text-sm">
              <span className="text-muted">Entry date</span>
              <input
                type="date"
                className="mt-1 w-full rounded-md border border-rule bg-white px-3 py-2"
                value={adjustment.entryDate}
                onChange={(event) =>
                  setAdjustment((current) => ({ ...current, entryDate: event.target.value }))
                }
              />
            </label>
            <label className="block text-sm md:col-span-2">
              <span className="text-muted">Memo</span>
              <input
                className="mt-1 w-full rounded-md border border-rule bg-white px-3 py-2"
                value={adjustment.memo}
                onChange={(event) =>
                  setAdjustment((current) => ({ ...current, memo: event.target.value }))
                }
                placeholder="Describe the adjustment"
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted">Debit account</span>
              <select
                className="mt-1 w-full rounded-md border border-rule bg-white px-3 py-2"
                value={adjustment.debitAccountId}
                onChange={(event) =>
                  setAdjustment((current) => ({ ...current, debitAccountId: event.target.value }))
                }
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} · {account.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-muted">Credit account</span>
              <select
                className="mt-1 w-full rounded-md border border-rule bg-white px-3 py-2"
                value={adjustment.creditAccountId}
                onChange={(event) =>
                  setAdjustment((current) => ({ ...current, creditAccountId: event.target.value }))
                }
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} · {account.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-muted">Amount</span>
              <input
                type="number"
                min="0"
                step="0.01"
                className="mt-1 w-full rounded-md border border-rule bg-white px-3 py-2 font-tabular"
                value={adjustment.amount}
                onChange={(event) =>
                  setAdjustment((current) => ({ ...current, amount: event.target.value }))
                }
              />
            </label>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={pending === "adjustment" || accounts.length < 2}
                className="rounded-md bg-navy px-4 py-2 text-sm text-white disabled:opacity-60"
              >
                {pending === "adjustment" ? "Posting…" : `Post ${money(Number(adjustment.amount) || 0)}`}
              </button>
            </div>
          </form>
        </article>
      ) : null}
    </div>
  );
}
