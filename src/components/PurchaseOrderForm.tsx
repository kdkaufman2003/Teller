"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { todayISO } from "@/lib/format";
import { purchaseOrderPath } from "@/lib/routes";

type Line = {
  description: string;
  quantity: number;
  unitCost: number;
  accountId: string;
  jobId: string;
  costCategory: string;
  costType: string;
};

type Account = { id: string; code: string; name: string };
type Party = { id: string; name: string };
type Job = { id: string; job_number: string; name: string };

export function PurchaseOrderForm({
  vendors,
  accounts,
  jobs,
}: {
  vendors: Party[];
  accounts: Account[];
  jobs: Job[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [partyId, setPartyId] = useState(vendors[0]?.id || "");
  const [jobId, setJobId] = useState("");
  const [issueDate, setIssueDate] = useState(todayISO());
  const [expectedDate, setExpectedDate] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([
    {
      description: "",
      quantity: 1,
      unitCost: 0,
      accountId: accounts[0]?.id || "",
      jobId: "",
      costCategory: "",
      costType: "",
    },
  ]);

  function updateLine(index: number, patch: Partial<Line>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/purchase-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partyId,
          jobId: jobId || undefined,
          issueDate,
          expectedDate: expectedDate || undefined,
          memo,
          lines: lines.filter((line) => line.description || line.unitCost > 0),
        }),
      });
      const payload = (await response.json()) as { error?: string; purchaseOrderId?: string };
      if (!response.ok) throw new Error(payload.error || "Could not create PO");
      router.push(purchaseOrderPath(payload.purchaseOrderId!));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create PO");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card p-4 space-y-4" onSubmit={(event) => void submit(event)}>
      <div className="grid gap-3 md:grid-cols-2">
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
          <span className="mb-1 block text-muted">Job (optional)</span>
          <select value={jobId} onChange={(event) => setJobId(event.target.value)}>
            <option value="">None</option>
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.job_number} · {job.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Issue date</span>
          <input type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Expected date</span>
          <input type="date" value={expectedDate} onChange={(event) => setExpectedDate(event.target.value)} />
        </label>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium">Lines</h3>
        {lines.map((line, index) => (
          <div key={index} className="grid gap-2 md:grid-cols-6 border-t pt-3">
            <input
              className="md:col-span-2"
              placeholder="Description"
              value={line.description}
              onChange={(event) => updateLine(index, { description: event.target.value })}
            />
            <input
              type="number"
              min="0"
              step="0.0001"
              placeholder="Qty"
              value={line.quantity}
              onChange={(event) => updateLine(index, { quantity: Number(event.target.value) })}
            />
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Unit cost"
              value={line.unitCost || ""}
              onChange={(event) => updateLine(index, { unitCost: Number(event.target.value) })}
            />
            <select
              value={line.accountId}
              onChange={(event) => updateLine(index, { accountId: event.target.value })}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
            </select>
            <input
              placeholder="Cost category"
              value={line.costCategory}
              onChange={(event) => updateLine(index, { costCategory: event.target.value })}
            />
          </div>
        ))}
        <button
          type="button"
          className="btn btn-ghost text-sm"
          onClick={() =>
            setLines((current) => [
              ...current,
              {
                description: "",
                quantity: 1,
                unitCost: 0,
                accountId: accounts[0]?.id || "",
                jobId: "",
                costCategory: "",
                costType: "",
              },
            ])
          }
        >
          Add line
        </button>
      </div>

      <label className="text-sm block">
        <span className="mb-1 block text-muted">Memo</span>
        <input value={memo} onChange={(event) => setMemo(event.target.value)} />
      </label>

      <button className="btn btn-brass" disabled={pending} type="submit">
        Create draft PO
      </button>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </form>
  );
}
