"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { todayISO } from "@/lib/format";

type Customer = { id: string; name: string };

export function RecordCustomerDepositPanel({ customers }: { customers: Customer[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [partyId, setPartyId] = useState(customers[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [paymentMethod, setPaymentMethod] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [memo, setMemo] = useState("");
  const receiptEventIdRef = useRef<string | null>(null);

  function ensureReceiptEventId() {
    if (!receiptEventIdRef.current) {
      receiptEventIdRef.current = crypto.randomUUID();
    }
    return receiptEventIdRef.current;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/deposits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partyId,
          amount: Number(amount),
          paymentDate,
          paymentMethod: paymentMethod.trim() || undefined,
          referenceNumber: referenceNumber.trim() || undefined,
          memo: memo.trim() || undefined,
          receiptEventId: ensureReceiptEventId(),
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not record deposit");
      receiptEventIdRef.current = null;
      setAmount("");
      setMemo("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record deposit");
    } finally {
      setPending(false);
    }
  }

  if (!customers.length) return null;

  return (
    <form className="card p-4 space-y-4" onSubmit={(event) => void submit(event)}>
      <div>
        <h2 className="font-medium">Record customer deposit</h2>
        <p className="text-sm text-muted">
          Money received before an invoice exists — held as Customer Deposits liability.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-muted">Customer</span>
          <select value={partyId} onChange={(event) => setPartyId(event.target.value)} required>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Amount</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Date received</span>
          <input
            type="date"
            value={paymentDate}
            onChange={(event) => setPaymentDate(event.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Payment method</span>
          <input
            value={paymentMethod}
            onChange={(event) => setPaymentMethod(event.target.value)}
            placeholder="Check, card, ACH…"
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
      <button className="btn btn-primary" disabled={pending} type="submit">
        Record deposit
      </button>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </form>
  );
}
