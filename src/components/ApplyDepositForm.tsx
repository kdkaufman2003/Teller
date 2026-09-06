"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { todayISO } from "@/lib/format";

type DepositOption = {
  id: string;
  remaining: number;
  payment_date: string;
  reference_number?: string | null;
};

export function ApplyDepositForm({
  invoiceId,
  partyId,
  invoiceRemaining,
  deposits,
}: {
  invoiceId: string;
  partyId: string;
  invoiceRemaining: number;
  deposits: DepositOption[];
}) {
  const router = useRouter();
  const available = deposits.filter((row) => row.remaining > 0.009);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [paymentId, setPaymentId] = useState(available[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [applicationDate, setApplicationDate] = useState(todayISO());
  const applicationEventIdRef = useRef<string | null>(null);

  function ensureApplicationEventId() {
    if (!applicationEventIdRef.current) {
      applicationEventIdRef.current = crypto.randomUUID();
    }
    return applicationEventIdRef.current;
  }

  const selected = available.find((row) => row.id === paymentId);
  const maxApply = selected
    ? Math.min(selected.remaining, invoiceRemaining)
    : invoiceRemaining;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!paymentId) return;
    setError("");
    setPending(true);
    try {
      const response = await fetch(`/api/deposits/${paymentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "apply",
          invoiceId,
          amount: Number(amount),
          applicationDate,
          applicationEventId: ensureApplicationEventId(),
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not apply deposit");
      applicationEventIdRef.current = null;
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply deposit");
    } finally {
      setPending(false);
    }
  }

  if (!partyId || invoiceRemaining <= 0.009 || !available.length) return null;

  return (
    <div className="space-y-3">
      {!open ? (
        <button className="btn btn-ghost" type="button" onClick={() => {
          applicationEventIdRef.current = null;
          setOpen(true);
        }}>
          Apply deposit
        </button>
      ) : (
        <form className="card p-4 space-y-3" onSubmit={(event) => void submit(event)}>
          <div>
            <p className="font-medium">Apply deposit to invoice</p>
            <p className="text-sm text-muted">
              Invoice remaining ${invoiceRemaining.toFixed(2)} — no additional cash movement.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm md:col-span-2">
              <span className="mb-1 block text-muted">Deposit</span>
              <select
                value={paymentId}
                onChange={(event) => {
                  setPaymentId(event.target.value);
                  const dep = available.find((row) => row.id === event.target.value);
                  if (dep) {
                    setAmount(Math.min(dep.remaining, invoiceRemaining).toFixed(2));
                  }
                }}
              >
                {available.map((row) => (
                  <option key={row.id} value={row.id}>
                    ${row.remaining.toFixed(2)} available
                    {row.reference_number ? ` · ${row.reference_number}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">Amount to apply</span>
              <input
                type="number"
                min="0.01"
                max={maxApply}
                step="0.01"
                required
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">Application date</span>
              <input
                type="date"
                value={applicationDate}
                onChange={(event) => setApplicationDate(event.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={pending} type="submit">
              Apply deposit
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </form>
      )}
    </div>
  );
}
