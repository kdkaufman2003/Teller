"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate } from "@/lib/format";
import { TAX_EXEMPTION_CERTIFICATE_TYPES } from "@/lib/accounting/tax/exemptions/types";

type ExemptionRow = {
  id: string;
  certificateNumber?: string | null;
  certificateType?: string | null;
  jurisdictionScope: string[];
  categoryScope: string[];
  effectiveFrom: string;
  effectiveTo?: string | null;
  lifecycleStatus: string;
  status: string;
  expirationWarning?: string | null;
};

const EMPTY_FORM = {
  certificateNumber: "",
  certificateType: "resale",
  jurisdictionScope: "",
  categoryScope: "*",
  effectiveFrom: new Date().toISOString().slice(0, 10),
  effectiveTo: "",
  notes: "",
};

export function TaxExemptionsPanel({ partyId }: { partyId: string }) {
  const [rows, setRows] = useState<ExemptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch(`/api/tax/exemptions?partyId=${encodeURIComponent(partyId)}`);
    const data = await response.json();
    setLoading(false);
    if (!response.ok) {
      setMessage(data.error || "Could not load exemptions");
      return;
    }
    setRows(data.exemptions ?? []);
  }, [partyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createExemption() {
    setSaving(true);
    setMessage("");
    const response = await fetch("/api/tax/exemptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        partyId,
        certificateNumber: form.certificateNumber || null,
        certificateType: form.certificateType,
        jurisdictionScope: form.jurisdictionScope.split(",").map((s) => s.trim()).filter(Boolean),
        categoryScope: form.categoryScope.split(",").map((s) => s.trim()).filter(Boolean),
        effectiveFrom: form.effectiveFrom,
        effectiveTo: form.effectiveTo || null,
        notes: form.notes || null,
      }),
    });
    const data = await response.json();
    setSaving(false);
    if (!response.ok) {
      setMessage(data.error || "Could not create exemption");
      return;
    }
    setShowForm(false);
    setForm(EMPTY_FORM);
    await load();
  }

  async function activate(id: string) {
    const response = await fetch(`/api/tax/exemptions/${id}/activate`, { method: "POST" });
    if (!response.ok) {
      const data = await response.json();
      setMessage(data.error || "Activation failed");
      return;
    }
    await load();
  }

  async function revoke(id: string) {
    const response = await fetch(`/api/tax/exemptions/${id}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      const data = await response.json();
      setMessage(data.error || "Revocation failed");
      return;
    }
    await load();
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-rule px-4 py-3">
        <div className="font-medium">Tax Exemptions</div>
        <button type="button" className="btn-secondary text-sm" onClick={() => setShowForm((v) => !v)}>
          Add Exemption
        </button>
      </div>

      {message ? <p className="px-4 py-2 text-sm text-red-700">{message}</p> : null}

      {showForm ? (
        <div className="space-y-3 border-b border-rule px-4 py-4 text-sm">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              Certificate Number
              <input
                className="mt-1 w-full rounded-md border border-rule px-3 py-2"
                value={form.certificateNumber}
                onChange={(e) => setForm({ ...form, certificateNumber: e.target.value })}
              />
            </label>
            <label className="block">
              Exemption Type
              <select
                className="mt-1 w-full rounded-md border border-rule px-3 py-2"
                value={form.certificateType}
                onChange={(e) => setForm({ ...form, certificateType: e.target.value })}
              >
                {TAX_EXEMPTION_CERTIFICATE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
            <label className="block md:col-span-2">
              Where It Applies (jurisdiction keys, comma-separated)
              <input
                className="mt-1 w-full rounded-md border border-rule px-3 py-2"
                placeholder="US-KS, US-MO"
                value={form.jurisdictionScope}
                onChange={(e) => setForm({ ...form, jurisdictionScope: e.target.value })}
              />
            </label>
            <label className="block md:col-span-2">
              Applies To (categories, * for all)
              <input
                className="mt-1 w-full rounded-md border border-rule px-3 py-2"
                value={form.categoryScope}
                onChange={(e) => setForm({ ...form, categoryScope: e.target.value })}
              />
            </label>
            <label className="block">
              Effective Date
              <input
                type="date"
                className="mt-1 w-full rounded-md border border-rule px-3 py-2"
                value={form.effectiveFrom}
                onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
              />
            </label>
            <label className="block">
              Expiration Date
              <input
                type="date"
                className="mt-1 w-full rounded-md border border-rule px-3 py-2"
                value={form.effectiveTo}
                onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-primary" disabled={saving} onClick={() => void createExemption()}>
              Save Draft
            </button>
            <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <table className="data-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Certificate</th>
            <th>Where It Applies</th>
            <th>Applies To</th>
            <th>Effective</th>
            <th>Expires</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={8} className="text-muted">
                Loading…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="text-muted">
                No exemption certificates on file
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td>{row.certificateType || "other"}</td>
                <td>{row.certificateNumber || "—"}</td>
                <td>{row.jurisdictionScope.join(", ")}</td>
                <td>{row.categoryScope.join(", ")}</td>
                <td>{formatDate(row.effectiveFrom)}</td>
                <td>{row.effectiveTo ? formatDate(row.effectiveTo) : "—"}</td>
                <td>
                  <StatusBadge status={row.lifecycleStatus === "active" ? "active" : row.lifecycleStatus} />
                  {row.expirationWarning === "expires_within_30_days" ? (
                    <span className="ml-2 text-xs text-amber-700">Expires soon</span>
                  ) : null}
                </td>
                <td className="text-right space-x-2">
                  {row.lifecycleStatus === "draft" || row.status === "pending" ? (
                    <button type="button" className="text-sm text-navy underline" onClick={() => void activate(row.id)}>
                      Activate
                    </button>
                  ) : null}
                  {row.lifecycleStatus === "active" ? (
                    <button type="button" className="text-sm text-red-700 underline" onClick={() => void revoke(row.id)}>
                      Revoke
                    </button>
                  ) : null}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
