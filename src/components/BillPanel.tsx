"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { todayISO } from "@/lib/format";

type Account = { id: string; code: string; name: string; type: string };
type Party = { id: string; name: string };

export function BillPanel({
  accounts,
  vendors,
}: {
  accounts: Account[];
  vendors: Party[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [partyId, setPartyId] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [issueDate, setIssueDate] = useState(todayISO());
  const [dueDate, setDueDate] = useState(todayISO());
  const [memo, setMemo] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/bills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partyId: partyId || undefined,
          vendorName: partyId ? undefined : vendorName.trim() || undefined,
          issueDate,
          dueDate,
          memo,
          referenceNumber,
          lines: [
            {
              description: description || memo || "Bill line",
              quantity: 1,
              unit_price: Number(amount),
              accountId,
            },
          ],
        }),
      });
      const payload = (await response.json()) as { error?: string; id?: string };
      if (!response.ok) throw new Error(payload.error || "Could not create bill");
      router.push(`/app/bills/${payload.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create bill");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card p-4 space-y-4" onSubmit={(event) => void submit(event)}>
      <div>
        <h2 className="font-medium">New vendor bill</h2>
        <p className="text-sm text-muted">Amounts owed — pay later via AP.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-muted">Vendor</span>
          <select value={partyId} onChange={(event) => setPartyId(event.target.value)}>
            <option value="">New vendor…</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </select>
        </label>
        {!partyId ? (
          <label className="text-sm">
            <span className="mb-1 block text-muted">Vendor name</span>
            <input value={vendorName} onChange={(event) => setVendorName(event.target.value)} />
          </label>
        ) : null}
        <label className="text-sm">
          <span className="mb-1 block text-muted">Bill date</span>
          <input type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Due date</span>
          <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Vendor bill #</span>
          <input
            value={referenceNumber}
            onChange={(event) => setReferenceNumber(event.target.value)}
            placeholder="Supplier invoice number"
          />
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
        <label className="text-sm md:col-span-2">
          <span className="mb-1 block text-muted">Expense / COGS / asset account</span>
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm md:col-span-2">
          <span className="mb-1 block text-muted">Description</span>
          <input value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="text-sm md:col-span-2">
          <span className="mb-1 block text-muted">Memo</span>
          <input value={memo} onChange={(event) => setMemo(event.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={pending} type="submit">
          Create & post bill
        </button>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </form>
  );
}
