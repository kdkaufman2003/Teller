"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { todayISO } from "@/lib/format";

export function ExpenseForm({
  accounts,
}: {
  accounts: { id: string; code: string; name: string }[];
}) {
  const router = useRouter();
  const [vendorName, setVendorName] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [issueDate, setIssueDate] = useState(todayISO());
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorName,
          accountId,
          amount: Number(amount),
          memo,
          issueDate,
          paid: true,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not save");
      setVendorName("");
      setAmount("");
      setMemo("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card grid gap-3 p-4 md:grid-cols-5">
      <input
        placeholder="Vendor"
        value={vendorName}
        onChange={(event) => setVendorName(event.target.value)}
      />
      <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.code} {account.name}
          </option>
        ))}
      </select>
      <input
        placeholder="Amount"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        required
      />
      <input
        type="date"
        value={issueDate}
        onChange={(event) => setIssueDate(event.target.value)}
      />
      <button className="btn btn-primary" disabled={pending} type="submit">
        Record expense
      </button>
      <input
        className="md:col-span-5"
        placeholder="Memo"
        value={memo}
        onChange={(event) => setMemo(event.target.value)}
      />
      {error ? <p className="text-sm text-danger md:col-span-5">{error}</p> : null}
    </form>
  );
}
