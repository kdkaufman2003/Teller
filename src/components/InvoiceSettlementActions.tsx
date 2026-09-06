"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { todayISO } from "@/lib/format";

type SettlementFormProps = {
  title: string;
  amountLabel: string;
  defaultAmount: number;
  maxAmount: number;
  submitLabel: string;
  onSubmit: (input: { amount: number; date: string; reason: string }) => Promise<void>;
};

function SettlementForm({
  title,
  amountLabel,
  defaultAmount,
  maxAmount,
  submitLabel,
  onSubmit,
}: SettlementFormProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(defaultAmount.toFixed(2));
  const [date, setDate] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function handleSubmit() {
    setError("");
    setPending(true);
    try {
      await onSubmit({ amount: Number(amount), date, reason: reason.trim() });
      setOpen(false);
      setReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <button className="btn btn-ghost" type="button" onClick={() => setOpen(true)}>
        {title}
      </button>
    );
  }

  return (
    <div className="card p-4 space-y-3">
      <p className="text-sm font-medium">{title}</p>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-muted">{amountLabel}</span>
          <input
            type="number"
            min="0.01"
            max={maxAmount}
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Date</span>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        <label className="text-sm md:col-span-3">
          <span className="mb-1 block text-muted">Reason</span>
          <input value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={pending} onClick={() => void handleSubmit()} type="button">
          {submitLabel}
        </button>
        <button className="btn btn-ghost" disabled={pending} onClick={() => setOpen(false)} type="button">
          Cancel
        </button>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}

export function InvoiceSettlementActions({
  invoiceId,
  remaining,
}: {
  invoiceId: string;
  remaining: number;
}) {
  const router = useRouter();

  async function postAction(body: Record<string, unknown>) {
    const response = await fetch(`/api/invoices/${invoiceId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(payload.error || "Request failed");
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {remaining > 0.009 ? (
        <SettlementForm
          amountLabel="Write-off amount"
          defaultAmount={remaining}
          maxAmount={remaining}
          submitLabel="Write off balance"
          title="Write off balance"
          onSubmit={({ amount, date, reason }) =>
            postAction({ action: "writeoff", amount, writeoffDate: date, reason })
          }
        />
      ) : null}
      <p className="text-sm text-muted">
        To refund cash after a legitimate sale, first create a credit memo (reduces the sale), then
        refund the available customer credit from the credit memo.
      </p>
    </div>
  );
}

export function DepositSettlementActions({
  depositId,
  remaining,
}: {
  depositId: string;
  remaining: number;
}) {
  const router = useRouter();

  async function postAction(body: Record<string, unknown>) {
    const response = await fetch(`/api/deposits/${depositId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(payload.error || "Request failed");
    router.refresh();
  }

  if (remaining <= 0.009) return null;

  return (
    <SettlementForm
      amountLabel="Refund amount"
      defaultAmount={remaining}
      maxAmount={remaining}
      submitLabel="Refund deposit"
      title="Refund deposit"
      onSubmit={({ amount, date, reason }) =>
        postAction({ action: "refund", amount, refundDate: date, reason })
      }
    />
  );
}

export function PaymentReverseAction({ paymentId, status }: { paymentId: string; status: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(todayISO());
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit() {
    setError("");
    setPending(true);
    try {
      const response = await fetch(`/api/payments/${paymentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reverse", reversalDate: date, reason: reason.trim() }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not reverse payment");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reverse payment");
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <button
        className="btn btn-ghost btn-sm"
        disabled={status === "void"}
        type="button"
        onClick={() => setOpen(true)}
      >
        Reverse payment
      </button>
    );
  }

  return (
    <div className="card p-4 space-y-3">
      <p className="text-sm font-medium">Reverse payment</p>
      <p className="text-sm text-muted">
        Use when the original payment should not have existed or was recorded incorrectly. This is
        not a customer refund.
      </p>
      <label className="text-sm block">
        <span className="mb-1 block text-muted">Reversal date</span>
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </label>
      <label className="text-sm block">
        <span className="mb-1 block text-muted">Reason</span>
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={pending} onClick={() => void submit()} type="button">
          Confirm reversal
        </button>
        <button className="btn btn-ghost" disabled={pending} onClick={() => setOpen(false)} type="button">
          Cancel
        </button>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
