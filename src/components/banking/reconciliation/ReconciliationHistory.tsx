"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatDate, money } from "@/lib/format";
import {
  fetchReconciliationHistory,
  reconciliationStatusLabel,
} from "@/lib/banking/reconciliation-client";
import type { ReconciliationSummary } from "@/lib/banking/types";
import { bankingReconcilePath, bankingReconciliationPath } from "@/lib/routes";

type HistoryRow = Record<string, unknown> & {
  id: string;
  bank_account_id: string;
  statement_end_date: string;
  beginning_reconciled_balance: number;
  statement_ending_balance: number;
  status: string;
  completed_at: string | null;
  summary: ReconciliationSummary;
};

export function ReconciliationHistory() {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const payload = await fetchReconciliationHistory();
        if (!cancelled) {
          setRows(payload.reconciliations as HistoryRow[]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load reconciliation history");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p className="text-sm text-muted">Loading reconciliation history…</p>;
  if (error) {
    return (
      <div className="rounded-lg border border-danger/30 bg-paper-strong p-4 text-sm text-danger">
        {error}
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="card p-6">
        <p className="text-sm text-muted">No reconciliations yet.</p>
        <Link href={bankingReconcilePath()} className="btn btn-primary mt-4 inline-flex">
          Start a reconciliation
        </Link>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Statement ending</th>
            <th scope="col">Beginning</th>
            <th scope="col">Ending</th>
            <th scope="col">Difference</th>
            <th scope="col">Status</th>
            <th scope="col">Completed</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{formatDate(row.statement_end_date)}</td>
              <td className="font-tabular">{money(row.beginning_reconciled_balance)}</td>
              <td className="font-tabular">{money(row.statement_ending_balance)}</td>
              <td className="font-tabular">{money(row.summary.difference)}</td>
              <td>{reconciliationStatusLabel(row.status)}</td>
              <td>{row.completed_at ? formatDate(row.completed_at.slice(0, 10)) : "—"}</td>
              <td className="text-right">
                {row.status === "in_progress" || row.status === "reopened" || row.status === "draft" ? (
                  <Link href={bankingReconcilePath(row.id)} className="text-sky font-semibold">
                    Continue
                  </Link>
                ) : (
                  <Link href={bankingReconciliationPath(row.id)} className="text-sky font-semibold">
                    View
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
