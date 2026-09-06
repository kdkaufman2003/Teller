"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { todayISO } from "@/lib/format";

export function BillActions({
  id,
  status,
  total,
  amountPaid,
  creditsApplied,
  remaining,
}: {
  id: string;
  status: string;
  total: number;
  amountPaid: number;
  creditsApplied: number;
  remaining: number;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [showPayForm, setShowPayForm] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [memo, setMemo] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");

  const canPay =
    (status === "open" || status === "partially_paid") && remaining > 0.009;
  const isOpenBill = status === "open" || status === "partially_paid";

  async function run(action: "void" | "post") {
    setError("");
    setPending(true);
    try {
      const response = await fetch(`/api/bills/${id}`, {
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
      const response = await fetch(`/api/bills/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "pay",
          amount,
          paymentDate,
          memo: memo.trim() || undefined,
          paymentMethod: paymentMethod.trim() || undefined,
          referenceNumber: referenceNumber.trim() || undefined,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Payment failed");
      setShowPayForm(false);
      setPaymentAmount("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      {isOpenBill || status === "paid" ? (
        <div className="card p-4 text-sm grid gap-2 md:grid-cols-4">
          <div>
            <p className="text-muted">Bill total</p>
            <p className="font-tabular font-medium">${total.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-muted">Paid</p>
            <p className="font-tabular font-medium">${amountPaid.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-muted">Credits applied</p>
            <p className="font-tabular font-medium">${creditsApplied.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-muted">Remaining</p>
            <p className="font-tabular font-medium">${remaining.toFixed(2)}</p>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {status === "draft" ? (
          <button className="btn btn-brass" disabled={pending} onClick={() => void run("post")}>
            Post bill
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
        {status !== "void" ? (
          <button className="btn btn-ghost" disabled={pending} onClick={() => void run("void")}>
            Void
          </button>
        ) : null}
      </div>

      {showPayForm && canPay ? (
        <div className="card p-4 space-y-3">
          <p className="text-sm font-medium">Record bill payment</p>
          <div className="grid gap-3 md:grid-cols-2">
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
              <span className="mb-1 block text-muted">Method</span>
              <input
                value={paymentMethod}
                onChange={(event) => setPaymentMethod(event.target.value)}
                placeholder="Check, ACH, card…"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">Reference #</span>
              <input
                value={referenceNumber}
                onChange={(event) => setReferenceNumber(event.target.value)}
              />
            </label>
            <label className="text-sm md:col-span-2">
              <span className="mb-1 block text-muted">Memo</span>
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
