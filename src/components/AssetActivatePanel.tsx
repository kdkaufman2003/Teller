"use client";

import { useState } from "react";

type AssetRow = {
  id: string;
  asset_number: string;
  name: string;
  status: string;
  acquisition_mode: string;
  original_cost: number;
  placed_in_service_date: string | null;
};

export function AssetActivatePanel({ asset }: { asset: AssetRow }) {
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function activate() {
    setLoading(true);
    setMessage("");
    const action =
      asset.acquisition_mode === "opening_balance"
        ? "opening_balance"
        : asset.acquisition_mode === "linked"
          ? "link"
          : "new_acquisition";

    const body: Record<string, unknown> = { action, entryDate };
    if (action === "new_acquisition") {
      body.paymentKind = "cash";
    }

    const response = await fetch(`/api/fixed-assets/${asset.id}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    setLoading(false);
    if (!response.ok) {
      setMessage(data.error || "Activation failed");
      return;
    }
    setMessage("Asset activated.");
    window.location.reload();
  }

  return (
    <div className="card space-y-3 p-4">
      <h2 className="font-medium">Activate asset</h2>
      <p className="text-muted text-sm">
        Mode: <strong>{asset.acquisition_mode}</strong>. Linked acquisitions require an existing
        capitalization journal via API.
      </p>
      <label className="block space-y-1">
        <span className="text-sm">Entry date</span>
        <input
          className="input"
          type="date"
          value={entryDate}
          onChange={(e) => setEntryDate(e.target.value)}
        />
      </label>
      {message ? <p className="text-sm">{message}</p> : null}
      {asset.acquisition_mode !== "linked" ? (
        <button type="button" className="btn btn-primary" disabled={loading} onClick={activate}>
          {loading ? "Activating…" : "Activate & post acquisition"}
        </button>
      ) : null}
    </div>
  );
}
