"use client";

import { useRef, useState } from "react";

type AssetRow = {
  id: string;
  asset_number: string;
  name: string;
};

const DISPOSAL_TYPES = [
  { value: "sold", label: "Sold" },
  { value: "retired", label: "Retired" },
  { value: "written_off", label: "Written off" },
  { value: "lost", label: "Lost" },
  { value: "other", label: "Other" },
] as const;

export function AssetDisposePanel({ asset }: { asset: AssetRow }) {
  const operationIdRef = useRef(crypto.randomUUID());
  const [disposalDate, setDisposalDate] = useState(new Date().toISOString().slice(0, 10));
  const [disposalType, setDisposalType] = useState<(typeof DISPOSAL_TYPES)[number]["value"]>("retired");
  const [proceeds, setProceeds] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submitDisposal() {
    setLoading(true);
    setMessage("");
    const operationId = operationIdRef.current;

    try {
      const response = await fetch(`/api/fixed-assets/${asset.id}/dispose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId,
          disposalDate,
          disposalType,
          proceeds: proceeds ? Number(proceeds) : 0,
          reason,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error || "Disposal failed");
        setLoading(false);
        return;
      }
      setMessage(data.duplicate ? "Disposal confirmed (retry matched completed operation)." : "Asset disposed.");
      window.location.reload();
    } catch {
      setMessage("Network error — use Retry to confirm with the same operation ID.");
      setLoading(false);
    }
  }

  function resetOperation() {
    operationIdRef.current = crypto.randomUUID();
    setMessage("");
  }

  return (
    <div className="card space-y-3 p-4">
      <h2 className="font-medium">Dispose asset</h2>
      <p className="text-muted text-sm">
        Disposal uses a stable operation ID for safe retries after network failures.
      </p>
      <label className="block space-y-1">
        <span className="text-sm">Disposal date</span>
        <input
          className="input"
          type="date"
          value={disposalDate}
          onChange={(e) => setDisposalDate(e.target.value)}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm">Disposal type</span>
        <select
          className="input"
          value={disposalType}
          onChange={(e) => setDisposalType(e.target.value as (typeof DISPOSAL_TYPES)[number]["value"])}
        >
          {DISPOSAL_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-sm">Proceeds (optional)</span>
        <input
          className="input"
          type="number"
          min="0"
          step="0.01"
          value={proceeds}
          onChange={(e) => setProceeds(e.target.value)}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm">Reason (optional)</span>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {message ? <p className="text-sm">{message}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={loading} onClick={submitDisposal}>
          {loading ? "Disposing…" : "Dispose asset"}
        </button>
        <button type="button" className="btn btn-secondary" disabled={loading} onClick={resetOperation}>
          New disposal operation
        </button>
      </div>
    </div>
  );
}
