"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { todayISO } from "@/lib/format";

export function VendorCreditForm({
  billId,
  partyId,
  billTotal,
  remaining,
  expenseAccounts,
}: {
  billId: string;
  partyId: string;
  billTotal: number;
  remaining: number;
  expenseAccounts: { id: string; code: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [amount, setAmount] = useState(remaining > 0 ? Math.min(500, remaining).toFixed(2) : "");
  const [reason, setReason] = useState("");
  const [accountId, setAccountId] = useState(expenseAccounts[0]?.id || "");
  const [applyNow, setApplyNow] = useState(true);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const creditAmount = Number(amount);
      const response = await fetch("/api/vendor-credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partyId,
          billId,
          applyToBillId: applyNow ? billId : undefined,
          reason,
          issueDate: todayISO(),
          lines: [
            {
              description: reason || "Vendor credit",
              quantity: 1,
              unit_price: creditAmount,
              accountId,
            },
          ],
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not create vendor credit");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create vendor credit");
    } finally {
      setPending(false);
    }
  }

  if (remaining <= 0.009) return null;

  return (
    <div className="space-y-3">
      {!open ? (
        <button className="btn btn-ghost" type="button" onClick={() => setOpen(true)}>
          Create vendor credit
        </button>
      ) : (
        <form className="card p-4 space-y-3" onSubmit={(event) => void submit(event)}>
          <div>
            <p className="font-medium">Vendor credit</p>
            <p className="text-sm text-muted">
              Bill total stays {billTotal.toFixed(2)} — credit reduces AP obligation.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-muted">Credit amount</span>
              <input
                type="number"
                min="0.01"
                max={remaining}
                step="0.01"
                required
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">Account</span>
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                {expenseAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} · {account.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm md:col-span-2">
              <span className="mb-1 block text-muted">Reason</span>
              <input required value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <label className="text-sm md:col-span-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={applyNow}
                onChange={(event) => setApplyNow(event.target.checked)}
              />
              Apply to this bill now
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={pending} type="submit">
              Create vendor credit
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
