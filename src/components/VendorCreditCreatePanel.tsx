"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { todayISO } from "@/lib/format";

type Account = { id: string; code: string; name: string };
type Party = { id: string; name: string };

export function VendorCreditCreatePanel({
  vendors,
  accounts,
}: {
  vendors: Party[];
  accounts: Account[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [partyId, setPartyId] = useState(vendors[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/vendor-credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partyId,
          reason,
          issueDate: todayISO(),
          post: true,
          lines: [
            {
              description: reason || "Vendor credit",
              quantity: 1,
              unit_price: Number(amount),
              accountId,
            },
          ],
        }),
      });
      const payload = (await response.json()) as { error?: string; id?: string };
      if (!response.ok) throw new Error(payload.error || "Could not create credit");
      router.push(`/app/vendor-credits/${payload.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create credit");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card p-4 space-y-3" onSubmit={(event) => void submit(event)}>
      <h2 className="font-medium">New vendor credit</h2>
      <div className="grid gap-3 md:grid-cols-4">
        <label className="text-sm">
          <span className="mb-1 block text-muted">Vendor</span>
          <select value={partyId} onChange={(event) => setPartyId(event.target.value)} required>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Amount</span>
          <input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Account</span>
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Reason</span>
          <input value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
      </div>
      <button className="btn btn-brass" disabled={pending} type="submit">
        Create & post credit
      </button>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </form>
  );
}
