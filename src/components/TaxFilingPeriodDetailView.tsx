"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TaxNav } from "@/components/TaxNav";
import { filingPeriodStatusLabel } from "@/lib/accounting/tax/owner";
import { formatDate, money } from "@/lib/format";
import { routes } from "@/lib/routes";

type ReconciliationPayload = {
  salesTaxAccrued: number;
  useTaxAccrued: number;
  salesTaxCredits: number;
  useTaxReversals: number;
  netSubledgerLiability: number;
  authorityPaymentsApplied?: number;
  beginningGlBalance: number;
  periodGlMovement: number;
  endingGlBalance: number;
  endingOutstandingLiability?: number;
  subledgerToGlDifference: number;
  exceptions: Array<{ code: string; message: string; severity: string }>;
  readiness: { ready: boolean; blockingReasons: string[] };
};

type PaymentSummary = {
  filedLiability: number;
  previouslyPaid: number;
  remainingBalance: number;
  unappliedPayments: number;
};

export function TaxFilingPeriodDetailView({ periodId }: { periodId: string }) {
  const [period, setPeriod] = useState<Record<string, unknown> | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconciliationPayload | null>(null);
  const [paymentSummary, setPaymentSummary] = useState<PaymentSummary | null>(null);
  const [accountantMode, setAccountantMode] = useState(false);
  const [message, setMessage] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [registrationId, setRegistrationId] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");

  useEffect(() => {
    void Promise.all([
      fetch(`/api/tax/filing-periods/${periodId}`).then((response) => response.json()),
      fetch("/api/tax/overview").then((response) => response.json()),
    ])
      .then(([periodData, overviewData]) => {
        if (periodData.error) {
          setMessage(periodData.error || "Could not load period");
          return;
        }
        setPeriod(periodData.period);
        setPaymentSummary((periodData.paymentSummary as PaymentSummary | null) ?? null);
        setRegistrationId(String(periodData.period?.registrationId ?? periodData.period?.registration_id ?? ""));
        const last = (periodData.period?.metadata as Record<string, unknown> | undefined)?.lastReconciliation;
        if (last && typeof last === "object") setReconciliation(last as ReconciliationPayload);
        if (!("error" in overviewData)) setAccountantMode(overviewData.presentationMode === "accountant");
      })
      .catch(() => setMessage("Could not load period"));
  }, [periodId]);

  async function load() {
    const response = await fetch(`/api/tax/filing-periods/${periodId}`);
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || "Could not load period");
      return;
    }
    setPeriod(data.period);
    setPaymentSummary((data.paymentSummary as PaymentSummary | null) ?? null);
    const last = (data.period?.metadata as Record<string, unknown> | undefined)?.lastReconciliation;
    if (last && typeof last === "object") setReconciliation(last as ReconciliationPayload);
  }

  async function recordPayment() {
    setMessage("");
    const amount = Number(paymentAmount);
    if (!registrationId || !amount || amount <= 0) {
      setMessage("Enter a valid payment amount and registration");
      return;
    }
    const response = await fetch("/api/tax/authority-payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        registrationId,
        paymentDate: String(period?.periodEnd ?? period?.period_end ?? new Date().toISOString().slice(0, 10)),
        cashAccountId: cashAccountId || undefined,
        baseTaxAmount: amount,
        allocations: [{ filingPeriodId: periodId, amount }],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || "Payment failed");
      return;
    }
    await load();
  }

  async function reconcile() {
    setMessage("");
    const response = await fetch(`/api/tax/filing-periods/${periodId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reconcile" }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || "Reconcile failed");
      return;
    }
    setReconciliation(data.reconciliation);
    await load();
  }

  if (!period) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <TaxNav />
        <p className="text-muted text-sm">Loading period detail…</p>
      </div>
    );
  }

  const status = String(period.status ?? "");
  const statusLabel = filingPeriodStatusLabel(status);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <TaxNav />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Filing period</h1>
          <p className="text-muted text-sm">
            {formatDate(String(period.periodStart ?? period.period_start))} –{" "}
            {formatDate(String(period.periodEnd ?? period.period_end))} · {statusLabel}
          </p>
          <p className="text-muted text-xs">
            Filed and paid are tracked separately based on your Teller records.
          </p>
        </div>
        <div className="flex gap-3">
          {accountantMode ? (
            <button type="button" className="btn btn-secondary" onClick={() => void reconcile()}>
              Reconcile
            </button>
          ) : null}
          <Link href={routes.taxPeriods} className="self-center text-sm underline">
            Back to periods
          </Link>
        </div>
      </div>

      {message ? <p className="text-destructive text-sm">{message}</p> : null}

      {paymentSummary ? (
        <section className="card space-y-3 p-4" aria-label="Period summary">
          <h2 className="font-medium">Summary</h2>
          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-muted">Tax owed</dt>
              <dd className="text-lg font-medium">{money(paymentSummary.filedLiability)}</dd>
            </div>
            <div>
              <dt className="text-muted">Paid</dt>
              <dd className="text-lg font-medium">{money(paymentSummary.previouslyPaid)}</dd>
            </div>
            <div>
              <dt className="text-muted">Remaining</dt>
              <dd className="text-lg font-medium">{money(paymentSummary.remainingBalance)}</dd>
            </div>
            <div>
              <dt className="text-muted">Status</dt>
              <dd className="text-lg font-medium">{statusLabel}</dd>
            </div>
          </dl>
          {paymentSummary.unappliedPayments > 0 ? (
            <p className="text-sm">
              Unapplied overpayment: {money(paymentSummary.unappliedPayments)}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="card space-y-3 p-4" aria-label="Record tax payment">
        <h2 className="font-medium">Payments</h2>
        <p className="text-muted text-sm">Record a payment to the tax authority for this period.</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            Payment amount
            <input
              className="input mt-1 block"
              value={paymentAmount}
              onChange={(event) => setPaymentAmount(event.target.value)}
              placeholder="0.00"
            />
          </label>
          {accountantMode ? (
            <label className="text-sm">
              Cash account ID
              <input
                className="input mt-1 block"
                value={cashAccountId}
                onChange={(event) => setCashAccountId(event.target.value)}
                placeholder="Optional if default bank exists"
              />
            </label>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={() => void recordPayment()}>
            Record payment
          </button>
        </div>
      </section>

      {reconciliation ? (
        <>
          {accountantMode ? (
            <section className="grid gap-4 md:grid-cols-2">
              <div className="card p-4">
                <h2 className="font-medium">Tax activity</h2>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt>Sales tax accrued</dt>
                    <dd>{money(reconciliation.salesTaxAccrued)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Use tax accrued</dt>
                    <dd>{money(reconciliation.useTaxAccrued)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Credits / reversals</dt>
                    <dd>{money(reconciliation.salesTaxCredits + reconciliation.useTaxReversals)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Authority payments</dt>
                    <dd>{money(reconciliation.authorityPaymentsApplied ?? 0)}</dd>
                  </div>
                  <div className="flex justify-between font-medium">
                    <dt>Net period liability</dt>
                    <dd>{money(reconciliation.netSubledgerLiability)}</dd>
                  </div>
                  <div className="flex justify-between font-medium">
                    <dt>Outstanding after payments</dt>
                    <dd>
                      {money(
                        reconciliation.endingOutstandingLiability ?? reconciliation.netSubledgerLiability,
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="card p-4">
                <h2 className="font-medium">Reconciliation</h2>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt>Beginning GL balance</dt>
                    <dd>{money(reconciliation.beginningGlBalance)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Period GL movement</dt>
                    <dd>{money(reconciliation.periodGlMovement)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Ending GL balance</dt>
                    <dd>{money(reconciliation.endingGlBalance)}</dd>
                  </div>
                  <div className="flex justify-between font-medium">
                    <dt>GL difference</dt>
                    <dd>{money(reconciliation.subledgerToGlDifference)}</dd>
                  </div>
                </dl>
              </div>
            </section>
          ) : null}

          <section className="card p-4">
            <h2 className="font-medium">Exceptions</h2>
            {!reconciliation.exceptions.length ? (
              <p className="text-muted mt-2 text-sm">No reconciliation exceptions.</p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {reconciliation.exceptions.map((row) => (
                  <li key={`${row.code}-${row.message}`}>
                    {accountantMode ? (
                      <>
                        <span className="font-mono text-xs">{row.code}</span> —{" "}
                      </>
                    ) : null}
                    {row.message}
                  </li>
                ))}
              </ul>
            )}
            {!reconciliation.readiness.ready ? (
              <p className="mt-3 text-sm text-amber-700">Needs review before filing readiness.</p>
            ) : (
              <p className="mt-3 text-sm text-emerald-700">Period reconciled and ready for review.</p>
            )}
          </section>
        </>
      ) : accountantMode ? (
        <p className="text-muted text-sm">Run reconcile to compute period liability and GL comparison.</p>
      ) : (
        <p className="text-muted text-sm">
          Reconciliation detail is available in accountant mode. Summary amounts above are based on your
          Teller records.
        </p>
      )}

      <Link href={routes.taxReports} className="text-sm underline">
        View tax reports for this organization
      </Link>
    </div>
  );
}
