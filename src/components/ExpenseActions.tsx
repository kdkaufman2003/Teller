"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { todayISO } from "@/lib/format";

export function ExpenseActions({
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

  const canPay =
    (status === "open" || status === "partially_paid") && remaining > 0.009;
  const isUnpaidBill = status === "open" || status === "partially_paid";

  async function voidExpense() {
    setError("");
    setPending(true);
    try {
      const response = await fetch(`/api/expenses/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "void" }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not void expense");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not void expense");
    } finally {
      setPending(false);
    }
  }

  async function recordPayment(payRemaining: boolean) {
    setError("");
    setPending(true);
    try {
      const amount = payRemaining ? remaining : Number(paymentAmount);
      const response = await fetch(`/api/expenses/${id}`, {
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

  return (
    <div className="space-y-3">
      {isUnpaidBill || status === "paid" ? (
        <div className="card p-4 text-sm grid gap-2 md:grid-cols-3">
          <div>
            <p className="text-muted">Bill total</p>
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
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
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
              Pay bill
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
        {status !== "void" ? (
          <button className="btn btn-ghost" disabled={pending} onClick={() => void voidExpense()}>
            Void
          </button>
        ) : null}
      </div>

      {showPayForm && canPay ? (
        <div className="card p-4 space-y-3">
          <p className="text-sm font-medium">Pay bill</p>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm">
              <span className="mb-1 block text-muted">Payment amount</span>
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
              <span className="mb-1 block text-muted">Reference (optional)</span>
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
              Record payment
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
    </div>
  );
}
