"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { todayISO } from "@/lib/format";
import { InvoiceSettlementActions } from "@/components/InvoiceSettlementActions";

export function InvoiceActions({
  id,
  status,
  total,
  amountPaid,
  remaining,
}: {
  id: string;
  status: string;
  total: number;
  amountPaid: number;
  remaining: number;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [showPayForm, setShowPayForm] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [memo, setMemo] = useState("");

  async function run(action: "open" | "void") {
    setError("");
    setPending(true);
    try {
      const response = await fetch(`/api/invoices/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Update failed");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setPending(false);
    }
  }

  async function recordPayment(payRemaining: boolean) {
    setError("");
    setPending(true);
    try {
      const amount = payRemaining ? remaining : Number(paymentAmount);
      const response = await fetch(`/api/invoices/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "pay",
          amount,
          paymentDate,
          memo: memo.trim() || undefined,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Payment failed");
      setShowPayForm(false);
      setPaymentAmount("");
      setMemo("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed");
    } finally {
      setPending(false);
    }
  }

  const canPay =
    (status === "open" || status === "partially_paid") && remaining > 0.009;
  const hasPartialPayment = amountPaid > 0.009 && remaining > 0.009;

  return (
    <div className="space-y-3">
      {(status === "open" || status === "paid") && total > 0 ? (
        <div className="card p-4 text-sm grid gap-2 md:grid-cols-3">
          <div>
            <p className="text-muted">Invoice total</p>
            <p className="font-tabular font-medium">${total.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-muted">Amount paid</p>
            <p className="font-tabular font-medium">${amountPaid.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-muted">Remaining balance</p>
            <p className="font-tabular font-medium">${remaining.toFixed(2)}</p>
          </div>
          {hasPartialPayment ? (
            <p className="md:col-span-3 text-muted">Partial payment recorded — balance remains open.</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {status === "draft" ? (
          <button className="btn btn-primary" disabled={pending} onClick={() => void run("open")}>
            Post to ledger
          </button>
        ) : null}
        {canPay ? (
          <>
            <button
              className="btn btn-brass"
              disabled={pending}
              onClick={() => {
                setShowPayForm((value) => !value);
                setPaymentAmount(remaining.toFixed(2));
              }}
            >
              Record payment
            </button>
            {!showPayForm ? (
              <button
                className="btn btn-ghost"
                disabled={pending}
                onClick={() => void recordPayment(true)}
              >
                Pay remaining (${remaining.toFixed(2)})
              </button>
            ) : null}
          </>
        ) : null}
        {status !== "void" && status !== "paid" ? (
          <button className="btn btn-ghost" disabled={pending} onClick={() => void run("void")}>
            Void
          </button>
        ) : null}
      </div>

      {showPayForm && canPay ? (
        <div className="card p-4 space-y-3">
          <p className="text-sm font-medium">Record payment</p>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm">
              <span className="mb-1 block text-muted">Amount received</span>
              <input
                type="number"
                min="0.01"
                max={remaining}
                step="0.01"
                value={paymentAmount}
                onChange={(event) => setPaymentAmount(event.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">Payment date</span>
              <input
                type="date"
                value={paymentDate}
                onChange={(event) => setPaymentDate(event.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">Memo (optional)</span>
              <input value={memo} onChange={(event) => setMemo(event.target.value)} />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-primary"
              disabled={pending}
              onClick={() => void recordPayment(false)}
              type="button"
            >
              Post payment
            </button>
            <button
              className="btn btn-ghost"
              disabled={pending}
              onClick={() => setShowPayForm(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {(status === "open" || status === "partially_paid" || status === "paid") && remaining > 0.009 ? (
        <InvoiceSettlementActions invoiceId={id} remaining={remaining} />
      ) : null}
    </div>
  );
}
