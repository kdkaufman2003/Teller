"use client";

import { money } from "@/lib/format";
import { canFinalize } from "@/lib/banking/reconciliation-client";
import type { ReconciliationSummary } from "@/lib/banking/types";

type Props = {
  summary: ReconciliationSummary;
  accountLabel: string;
  statementEndDate: string;
  sticky?: boolean;
};

export function ReconciliationSummaryCard({
  summary,
  accountLabel,
  statementEndDate,
  sticky = true,
}: Props) {
  const balanced = canFinalize(summary);

  return (
    <section
      className={`card p-5 ${sticky ? "lg:sticky lg:top-4" : ""}`}
      aria-live="polite"
      aria-label="Reconciliation summary"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-ledger text-xl text-navy">{accountLabel}</h2>
          <p className="text-sm text-muted">Statement ending {statementEndDate}</p>
        </div>
        <div
          className={`rounded-xl px-4 py-3 text-right ${
            balanced ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"
          }`}
        >
          <p className="text-xs font-semibold uppercase tracking-[0.14em]">Difference</p>
          <p className="font-tabular text-2xl font-semibold">{money(summary.difference)}</p>
        </div>
      </div>

      <dl className="mt-5 space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Beginning balance</dt>
          <dd className="font-tabular font-semibold">{money(summary.beginningReconciledBalance)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Deposits cleared</dt>
          <dd className="font-tabular font-semibold text-ok">
            {money(summary.clearedIncreases)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Payments cleared</dt>
          <dd className="font-tabular font-semibold text-danger">
            {summary.clearedDecreases > 0 ? `-${money(summary.clearedDecreases)}` : money(0)}
          </dd>
        </div>
        <div className="flex justify-between gap-4 border-t border-rule pt-2">
          <dt className="font-semibold text-ink">Calculated balance</dt>
          <dd className="font-tabular font-semibold">{money(summary.calculatedEndingBalance)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Statement balance</dt>
          <dd className="font-tabular font-semibold">{money(summary.statementEndingBalance)}</dd>
        </div>
      </dl>

      {balanced ? (
        <p className="mt-4 text-sm font-semibold text-ok">Your books match this statement.</p>
      ) : (
        <p className="mt-4 text-sm text-muted">
          Your statement and cleared transactions do not match yet. Review uncleared transactions or
          check your statement ending balance.
        </p>
      )}
    </section>
  );
}
