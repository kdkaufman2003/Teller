"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { routes } from "@/lib/routes";

export default function NewAssetPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [originalCost, setOriginalCost] = useState("");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("60");
  const [salvageValue, setSalvageValue] = useState("0");
  const [placedInServiceDate, setPlacedInServiceDate] = useState("");
  const [acquisitionMode, setAcquisitionMode] = useState<
    "linked" | "new_acquisition" | "opening_balance"
  >("new_acquisition");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const response = await fetch("/api/fixed-assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        acquisitionMode,
        originalCost: Number(originalCost),
        usefulLifeMonths: Number(usefulLifeMonths),
        salvageValue: Number(salvageValue),
        placedInServiceDate: placedInServiceDate || undefined,
      }),
    });
    const data = await response.json();
    setSaving(false);
    if (!response.ok) {
      setError(data.error || "Could not create asset");
      return;
    }
    router.push(`${routes.assets}/${data.asset.id}`);
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <header className="page-header">
        <h1>New fixed asset</h1>
      </header>
      <form onSubmit={submit} className="card space-y-4 p-6">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Name</span>
          <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Acquisition mode</span>
          <select
            className="input w-full"
            value={acquisitionMode}
            onChange={(e) => setAcquisitionMode(e.target.value as typeof acquisitionMode)}
          >
            <option value="new_acquisition">New acquisition</option>
            <option value="linked">Link existing capitalization</option>
            <option value="opening_balance">Opening balance</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Original cost</span>
          <input
            className="input w-full"
            type="number"
            min="0"
            step="0.01"
            value={originalCost}
            onChange={(e) => setOriginalCost(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Useful life (months)</span>
          <input
            className="input w-full"
            type="number"
            min="1"
            value={usefulLifeMonths}
            onChange={(e) => setUsefulLifeMonths(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Salvage value</span>
          <input
            className="input w-full"
            type="number"
            min="0"
            step="0.01"
            value={salvageValue}
            onChange={(e) => setSalvageValue(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Placed in service date</span>
          <input
            className="input w-full"
            type="date"
            value={placedInServiceDate}
            onChange={(e) => setPlacedInServiceDate(e.target.value)}
          />
        </label>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? "Creating…" : "Create draft asset"}
        </button>
      </form>
    </div>
  );
}
