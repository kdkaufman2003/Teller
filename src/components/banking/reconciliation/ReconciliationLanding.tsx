"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatDate, money } from "@/lib/format";
import {
  fetchReconciliationLanding,
  reconciliationStatusLabel,
} from "@/lib/banking/reconciliation-client";
import type { ReconciliationLandingAccount } from "@/lib/banking/types";
import { bankingReconcilePath, routes } from "@/lib/routes";

export function ReconciliationLanding() {
  const [accounts, setAccounts] = useState<ReconciliationLandingAccount[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const rows = await fetchReconciliationLanding();
        if (!cancelled) {
          setAccounts(rows);
          setError("");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load bank accounts");
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

  if (loading) {
    return <p className="text-sm text-muted">Loading bank accounts…</p>;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-danger/30 bg-paper-strong p-4 text-sm text-danger">
        {error}
      </div>
    );
  }

  if (!accounts.length) {
    return (
      <div className="card p-6">
        <h2 className="font-ledger text-xl text-navy">No bank accounts yet</h2>
        <p className="mt-2 text-sm text-muted">
          Add a bank account from the Transactions page using CSV import or a bank connection.
          Reconciliation works with imported or manually tracked accounts — no live bank feed
          required.
        </p>
        <Link href={routes.banking} className="btn btn-primary mt-4 inline-flex">
          Go to Transactions
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {accounts.map((account) => (
        <article key={account.bankAccountId} className="card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-ledger text-xl text-navy">{account.name}</h2>
              <p className="mt-1 text-sm text-muted">
                {[account.institutionName, account.accountSubtype || account.accountType]
                  .filter(Boolean)
                  .join(" · ")}
                {account.mask ? ` ·••${account.mask}` : ""}
              </p>
            </div>
            {account.activeReconciliation ? (
              <span className="rounded-full bg-warn/10 px-2.5 py-1 text-xs font-semibold text-warn">
                {reconciliationStatusLabel(account.activeReconciliation.status)}
              </span>
            ) : null}
          </div>

          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">Books</dt>
              <dd className="font-tabular font-semibold text-navy">{money(account.bookBalance)}</dd>
            </div>
            <div>
              <dt className="text-muted">Bank balance</dt>
              <dd className="font-tabular font-semibold text-navy">
                {account.providerBalance == null ? "Not connected" : money(account.providerBalance)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Last reconciled</dt>
              <dd>{formatDate(account.lastReconciledDate)}</dd>
            </div>
            <div>
              <dt className="text-muted">Last statement balance</dt>
              <dd className="font-tabular">
                {account.lastReconciledEndingBalance == null
                  ? "—"
                  : money(account.lastReconciledEndingBalance)}
              </dd>
            </div>
          </dl>

          <div className="mt-5 flex flex-wrap gap-2">
            {account.activeReconciliation ? (
              <Link
                href={bankingReconcilePath(account.activeReconciliation.id)}
                className="btn btn-primary"
              >
                Continue reconciliation
              </Link>
            ) : (
              <Link
                href={`${routes.bankingReconcile}/new?bankAccountId=${account.bankAccountId}`}
                className="btn btn-primary"
              >
                Reconcile
              </Link>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
