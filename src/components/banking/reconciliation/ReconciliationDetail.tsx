"use client";

import Link from "next/link";
import { formatDate, money, titleCase } from "@/lib/format";
import { reconciliationStatusLabel } from "@/lib/banking/reconciliation-client";
import type { ReconciliationWorkspacePayload } from "@/lib/banking/types";
import { bankingReconcilePath, routes } from "@/lib/routes";
import { ReconciliationSummaryCard } from "./ReconciliationSummaryCard";
import { ReopenReconciliationDialog } from "./ReopenReconciliationDialog";

type Props = {
  initialWorkspace: ReconciliationWorkspacePayload;
  canWrite: boolean;
};

export function ReconciliationDetail({ initialWorkspace, canWrite }: Props) {
  const accountLabel = `${initialWorkspace.bankAccount.name}${
    initialWorkspace.bankAccount.mask ? ` •••${initialWorkspace.bankAccount.mask}` : ""
  }`;
  const readOnly = initialWorkspace.reconciliation.status === "completed";

  return (
    <div className="space-y-6">
      <ReconciliationSummaryCard
        summary={initialWorkspace.summary}
        accountLabel={accountLabel}
        statementEndDate={formatDate(initialWorkspace.reconciliation.statementEndDate)}
        sticky={false}
      />

      <section className="card p-5">
        <h2 className="font-ledger text-xl text-navy">Statement details</h2>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">Status</dt>
            <dd>{reconciliationStatusLabel(initialWorkspace.reconciliation.status)}</dd>
          </div>
          <div>
            <dt className="text-muted">Statement period</dt>
            <dd>
              {formatDate(initialWorkspace.reconciliation.statementStartDate)} –{" "}
              {formatDate(initialWorkspace.reconciliation.statementEndDate)}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Completed</dt>
            <dd>
              {initialWorkspace.reconciliation.completedAt
                ? new Date(initialWorkspace.reconciliation.completedAt).toLocaleString()
                : "—"}
            </dd>
          </div>
          {initialWorkspace.reconciliation.reopenedAt ? (
            <div>
              <dt className="text-muted">Reopened</dt>
              <dd>
                {new Date(initialWorkspace.reconciliation.reopenedAt).toLocaleString()}
                {initialWorkspace.reconciliation.reopenReason
                  ? ` · ${initialWorkspace.reconciliation.reopenReason}`
                  : ""}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      {initialWorkspace.auditEvents.length ? (
        <section className="card p-5">
          <h2 className="font-ledger text-xl text-navy">Audit trail</h2>
          <ul className="mt-4 space-y-2 text-sm">
            {initialWorkspace.auditEvents.map((event) => (
              <li key={`${event.action}-${event.createdAt}`}>
                <span className="font-semibold">{titleCase(event.action.replace(/\./g, " "))}</span>
                <span className="text-muted"> · {new Date(event.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card overflow-hidden">
        <div className="border-b border-rule px-4 py-3">
          <h2 className="font-ledger text-lg text-navy">Cleared transactions</h2>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Description</th>
              <th scope="col" className="text-right">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {initialWorkspace.items.map((item) => (
              <tr key={item.id}>
                <td>{formatDate(item.postedDate ?? item.clearedDate)}</td>
                <td>{item.description ?? "Book activity"}</td>
                <td className="text-right font-tabular">{money(item.signedAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="flex flex-wrap gap-2">
        {readOnly && canWrite ? (
          <ReopenReconciliationDialog
            reconciliationId={initialWorkspace.reconciliation.id}
            onReopened={() => {
              window.location.href = bankingReconcilePath(initialWorkspace.reconciliation.id);
            }}
          />
        ) : null}
        {!readOnly ? (
          <Link
            href={bankingReconcilePath(initialWorkspace.reconciliation.id)}
            className="btn btn-primary"
          >
            Continue reconciliation
          </Link>
        ) : null}
        <Link href={routes.banking} className="btn btn-secondary">
          View transactions
        </Link>
        <Link href={routes.bankingReconciliations} className="btn btn-secondary">
          Reconciliation history
        </Link>
      </div>
    </div>
  );
}
