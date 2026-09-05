"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { addDaysISO, asNumber, money, todayISO } from "@/lib/format";
import { invoicePath, routes } from "@/lib/routes";

type Lookup = {
  customers: { id: string; name: string }[];
  jobs: { id: string; job_number: string; name: string }[];
  settings: { modules?: string[]; labels?: Record<string, string>; answers?: Record<string, unknown> } | null;
  taxRate: number;
  collectTax: boolean;
};

type Line = {
  description: string;
  quantity: string;
  unit_price: string;
  item_type: string;
};

const ITEM_TYPES = [
  { value: "equipment", label: "Equipment" },
  { value: "labor", label: "Labor" },
  { value: "service", label: "Service" },
  { value: "parts", label: "Parts" },
  { value: "maintenance", label: "Maintenance" },
  { value: "warranty", label: "Warranty" },
  { value: "subscription", label: "Subscription" },
  { value: "other", label: "Other" },
];

export function InvoiceForm() {
  const router = useRouter();
  const [lookups, setLookups] = useState<Lookup | null>(null);
  const [partyId, setPartyId] = useState("");
  const [jobId, setJobId] = useState("");
  const [issueDate, setIssueDate] = useState(todayISO());
  const [dueDate, setDueDate] = useState(addDaysISO(30));
  const [memo, setMemo] = useState("");
  const [taxRate, setTaxRate] = useState(0);
  const [collectTax, setCollectTax] = useState(true);
  const [lines, setLines] = useState<Line[]>([
    { description: "", quantity: "1", unit_price: "", item_type: "equipment" },
  ]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetch("/api/lookups")
      .then((res) => res.json())
      .then((data: Lookup) => {
        setLookups(data);
        setCollectTax(data.collectTax !== false);
        setTaxRate(data.collectTax === false ? 0 : data.taxRate || 0);
      })
      .catch(() => setLookups({ customers: [], jobs: [], settings: null, taxRate: 0, collectTax: false }));
  }, []);

  const subtotal = useMemo(
    () =>
      lines.reduce(
        (sum, line) => sum + asNumber(line.quantity, 1) * asNumber(line.unit_price),
        0,
      ),
    [lines],
  );
  const tax = collectTax ? Math.round(subtotal * (taxRate / 100) * 100) / 100 : 0;

  function updateLine(index: number, patch: Partial<Line>) {
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }

  async function save(status: "draft" | "open") {
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partyId: partyId || undefined,
          jobId: jobId || undefined,
          issueDate,
          dueDate,
          memo,
          taxRate,
          status,
          lines: lines.map((line) => ({
            description: line.description,
            quantity: asNumber(line.quantity, 1),
            unit_price: asNumber(line.unit_price),
            item_type: line.item_type,
          })),
        }),
      });
      const payload = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !payload.id) throw new Error(payload.error || "Save failed");
      router.push(invoicePath(payload.id));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setPending(false);
    }
  }

  const customerLabel = lookups?.settings?.labels?.customerSingular || "Customer";
  const showJobs = lookups?.settings?.modules?.includes("jobs");

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save("draft");
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-muted">{customerLabel}</span>
          <select value={partyId} onChange={(event) => setPartyId(event.target.value)}>
            <option value="">Select…</option>
            {lookups?.customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </label>
        {showJobs ? (
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Job</span>
            <select value={jobId} onChange={(event) => setJobId(event.target.value)}>
              <option value="">None</option>
              {lookups?.jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.job_number} · {job.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Issue date</span>
          <input type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Due date</span>
          <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
        </label>
      </div>

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Type</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Price</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td className="px-3 py-2">
                  <input
                    value={line.description}
                    onChange={(event) => updateLine(index, { description: event.target.value })}
                    placeholder="Indoor / condenser / labor…"
                  />
                </td>
                <td className="px-3 py-2">
                  <select
                    value={line.item_type}
                    onChange={(event) => updateLine(index, { item_type: event.target.value })}
                  >
                    {ITEM_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input
                    value={line.quantity}
                    onChange={(event) => updateLine(index, { quantity: event.target.value })}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    value={line.unit_price}
                    onChange={(event) => updateLine(index, { unit_price: event.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          type="button"
          className="btn btn-ghost m-3 text-sm"
          onClick={() =>
            setLines((current) => [
              ...current,
              { description: "", quantity: "1", unit_price: "", item_type: "equipment" },
            ])
          }
        >
          Add line
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Memo</span>
          <textarea value={memo} onChange={(event) => setMemo(event.target.value)} rows={3} />
        </label>
        <div className="card space-y-2 p-4 font-tabular">
          {collectTax ? (
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Tax rate %</span>
              <input
                className="w-24"
                value={taxRate}
                onChange={(event) => setTaxRate(Number(event.target.value))}
              />
            </label>
          ) : null}
          <p className="flex justify-between">
            <span>Subtotal</span>
            <span>{money(subtotal)}</span>
          </p>
          {collectTax ? (
            <p className="flex justify-between">
              <span>Tax</span>
              <span>{money(tax)}</span>
            </p>
          ) : null}
          <p className="flex justify-between text-lg font-semibold">
            <span>Total</span>
            <span>{money(subtotal + tax)}</span>
          </p>
        </div>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-ghost" disabled={pending}>
          Save draft
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending}
          onClick={() => void save("open")}
        >
          Save & post
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => router.push(routes.invoices)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
