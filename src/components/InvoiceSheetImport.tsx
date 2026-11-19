"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { InvoiceSheetRow } from "@/lib/accounting/invoice-sheet";

type Account = { id: string; code: string; name: string; type: string };
type Party = { id: string; name: string };

const STATUS_LABEL: Record<InvoiceSheetRow["status"], string> = {
  paid: "Paid",
  upcoming: "Upcoming",
  open: "Open",
  unknown: "Unknown",
};

export function InvoiceSheetImport({
  accounts,
  vendors,
}: {
  accounts: Account[];
  vendors: Party[];
}) {
  const router = useRouter();
  const [partyId, setPartyId] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");
  const [rows, setRows] = useState<InvoiceSheetRow[]>([]);
  const [attachmentPath, setAttachmentPath] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [pending, setPending] = useState(false);
  const [fileKey, setFileKey] = useState(0);

  async function onFile(file: File | null) {
    if (!file) return;
    setReading(true);
    setError("");
    setMessage("");
    setNotice("");
    setRows([]);
    setAttachmentPath(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/bills/import-sheet", { method: "POST", body: form });
      const payload = (await response.json()) as {
        error?: string;
        rows?: InvoiceSheetRow[];
        attachmentPath?: string | null;
        notice?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Could not read the invoice sheet");
      setRows(payload.rows ?? []);
      setAttachmentPath(payload.attachmentPath ?? null);
      setNotice(payload.notice?.trim() || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the invoice sheet");
    } finally {
      setReading(false);
    }
  }

  function updateRow(index: number, patch: Partial<InvoiceSheetRow>) {
    setRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  async function onImport(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/bills/import-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partyId: partyId || undefined,
          vendorName: partyId ? undefined : vendorName,
          accountId,
          attachmentPath,
          rows,
        }),
      });
      const payload = (await response.json()) as {
        error?: string;
        created?: { number: string }[];
        skipped?: { reference: string; reason: string }[];
      };
      if (!response.ok) throw new Error(payload.error || "Could not import the invoice sheet");
      const createdCount = payload.created?.length ?? 0;
      const skipped = payload.skipped ?? [];
      const vendor = partyId
        ? vendors.find((item) => item.id === partyId)?.name
        : vendorName.trim();
      setMessage(
        createdCount
          ? `Saved ${createdCount} draft bill${createdCount === 1 ? "" : "s"} for ${vendor || "this vendor"}. They stay off the ledger until you post them.`
          : "No new bills were saved.",
      );
      if (skipped.length) {
        setNotice(skipped.map((item) => `${item.reference}: ${item.reason}`).join(" "));
      }
      if (createdCount) {
        setRows([]);
        setAttachmentPath(null);
        setFileKey((current) => current + 1);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import the invoice sheet");
    } finally {
      setPending(false);
    }
  }

  const selected = rows.filter((row) => row.include && row.amount > 0).length;

  return (
    <form className="card space-y-4 p-4" onSubmit={(event) => void onImport(event)}>
      <div>
        <h2 className="font-medium">Import invoice sheet</h2>
        <p className="text-sm text-muted">
          Upload a vendor billing history — CSV, PDF, or a screenshot like an invoice list.
          Choose the vendor it came from. Each invoice is saved as a draft bill for that vendor.
        </p>
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
            <input
              value={vendorName}
              onChange={(event) => setVendorName(event.target.value)}
              placeholder="Vercel"
            />
          </label>
        ) : null}
        <label className="text-sm md:col-span-2">
          <span className="mb-1 block text-muted">Expense / COGS / asset account</span>
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm md:col-span-2">
          <span className="mb-1 block text-muted">Invoice sheet</span>
          <input
            key={fileKey}
            type="file"
            accept=".csv,text/csv,.txt,application/pdf,image/png,image/jpeg,image/webp"
            onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
          />
          <span className="mt-1 block text-xs text-muted">
            CSV columns: description, amount, date. Status and period are optional.
          </span>
        </label>
      </div>

      {reading ? <p className="text-sm text-muted">Reading the sheet…</p> : null}
      {rows.length ? (
        <div className="overflow-hidden rounded-lg border border-rule">
          <table className="data-table">
            <thead>
              <tr>
                <th>Import</th>
                <th>Invoice</th>
                <th>Status</th>
                <th>Date</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.reference}-${index}`}>
                  <td>
                    <input
                      type="checkbox"
                      checked={row.include}
                      onChange={(event) => updateRow(index, { include: event.target.checked })}
                      aria-label={`Import ${row.description}`}
                    />
                  </td>
                  <td>
                    <input
                      value={row.description}
                      onChange={(event) => updateRow(index, { description: event.target.value })}
                      aria-label="Invoice description"
                    />
                    {row.period ? <p className="mt-1 text-xs text-muted">{row.period}</p> : null}
                  </td>
                  <td className="text-muted">{STATUS_LABEL[row.status]}</td>
                  <td>
                    <input
                      type="date"
                      value={row.issueDate ?? ""}
                      onChange={(event) => updateRow(index, { issueDate: event.target.value || null })}
                      aria-label="Invoice date"
                    />
                  </td>
                  <td className="text-right">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="w-28 text-right"
                      value={row.amount}
                      onChange={(event) => updateRow(index, { amount: Number(event.target.value) })}
                      aria-label="Invoice amount"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" type="submit" disabled={pending || reading || selected === 0}>
          {pending ? "Saving…" : selected ? `Save ${selected} draft bill${selected === 1 ? "" : "s"}` : "Save draft bills"}
        </button>
        <p className="text-sm text-muted">
          Paid rows stay drafts. Post a bill when it belongs in the ledger.
        </p>
      </div>
      {message ? <p className="text-sm text-ok">{message}</p> : null}
      {notice ? <p className="text-sm text-muted">{notice}</p> : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </form>
  );
}
