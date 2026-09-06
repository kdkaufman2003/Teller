"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDate, money, todayISO } from "@/lib/format";
import {
  fetchReconciliationHistory,
  startReconciliation,
} from "@/lib/banking/reconciliation-client";
import { bankingReconcilePath } from "@/lib/routes";

type SetupProps = {
  bankAccountId: string;
  accountName: string;
  canWrite: boolean;
};

export function ReconciliationSetupForm({ bankAccountId, accountName, canWrite }: SetupProps) {
  const router = useRouter();
  const [statementEndDate, setStatementEndDate] = useState(todayISO());
  const [statementEndingBalance, setStatementEndingBalance] = useState("");
  const [beginningBalance, setBeginningBalance] = useState<number | null>(null);
  const [lastReconciledDate, setLastReconciledDate] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const payload = await fetchReconciliationHistory(bankAccountId);
        if (cancelled) return;
        setBeginningBalance(payload.suggestedBeginningBalance ?? 0);
        const last = payload.lastCompletedReconciliation as
          | { statement_end_date?: string }
          | null;
        setLastReconciledDate(last?.statement_end_date ?? null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load setup details");
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [bankAccountId]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canWrite) return;
    setError("");
    setPending(true);
    try {
      const ending = Number(statementEndingBalance);
      if (!Number.isFinite(ending)) {
        throw new Error("Enter a valid statement ending balance");
      }
      const startDate = lastReconciledDate
        ? new Date(`${lastReconciledDate}T00:00:00`)
        : new Date(`${statementEndDate}T00:00:00`);
      if (lastReconciledDate) {
        startDate.setDate(startDate.getDate() + 1);
      } else {
        startDate.setMonth(startDate.getMonth() - 1);
      }
      const statementStartDate = startDate.toISOString().slice(0, 10);
      if (statementEndDate < statementStartDate) {
        throw new Error("Statement ending date must be on or after the period start");
      }

      const reconciliationId = await startReconciliation({
        bankAccountId,
        statementStartDate,
        statementEndDate,
        statementEndingBalance: ending,
        beginningReconciledBalance: beginningBalance,
      });
      router.push(bankingReconcilePath(reconciliationId));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start reconciliation");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="card max-w-2xl p-6 space-y-5">
      <div>
        <label className="text-sm font-semibold text-muted">Account</label>
        <p className="mt-1 text-lg font-ledger text-navy">{accountName}</p>
      </div>

      <div>
        <label htmlFor="statement-end-date" className="text-sm font-semibold text-muted">
          Statement ending date
        </label>
        <input
          id="statement-end-date"
          type="date"
          required
          value={statementEndDate}
          onChange={(event) => setStatementEndDate(event.target.value)}
          className="mt-1"
        />
      </div>

      <div>
        <label htmlFor="statement-ending-balance" className="text-sm font-semibold text-muted">
          Statement ending balance
        </label>
        <input
          id="statement-ending-balance"
          type="number"
          step="0.01"
          required
          inputMode="decimal"
          placeholder="0.00"
          value={statementEndingBalance}
          onChange={(event) => setStatementEndingBalance(event.target.value)}
          className="mt-1 font-tabular"
        />
      </div>

      <div className="rounded-lg bg-paper p-4">
        <p className="text-sm font-semibold text-muted">Beginning balance</p>
        <p className="mt-1 font-tabular text-2xl font-ledger text-navy">
          {beginningBalance == null ? "…" : money(beginningBalance)}
        </p>
        <p className="mt-2 text-sm text-muted">
          {lastReconciledDate
            ? `Based on your previous reconciliation ending ${formatDate(lastReconciledDate)}.`
            : "First reconciliation for this account — beginning balance starts at $0.00 unless you enter a different value when supported by your records."}
        </p>
      </div>

      {error ? (
        <p className="rounded-lg border border-danger/30 bg-paper-strong p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending || !canWrite}>
          {pending ? "Starting…" : "Start reconciliation"}
        </button>
      </div>
    </form>
  );
}
