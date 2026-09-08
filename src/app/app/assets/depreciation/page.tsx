"use client";

import { useEffect, useState } from "react";
import { money } from "@/lib/format";

export default function DepreciationPage() {
  const [periodYear, setPeriodYear] = useState(2026);
  const [periodMonth, setPeriodMonth] = useState(10);
  const [entryDate, setEntryDate] = useState("2026-10-01");
  const [preview, setPreview] = useState<{
    rows: { assetNumber: string; name: string; calculatedAmount: number; posted: boolean }[];
    totalCalculated: number;
    totalReadyToPost: number;
  } | null>(null);
  const [message, setMessage] = useState("");

  async function loadPreview() {
    const response = await fetch(
      `/api/fixed-assets/depreciation?periodYear=${periodYear}&periodMonth=${periodMonth}`,
    );
    const data = await response.json();
    if (response.ok) setPreview(data);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(
        `/api/fixed-assets/depreciation?periodYear=${periodYear}&periodMonth=${periodMonth}`,
      );
      const data = await response.json();
      if (!cancelled && response.ok) setPreview(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [periodYear, periodMonth]);

  async function postBatch() {
    setMessage("");
    const response = await fetch("/api/fixed-assets/depreciation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ periodYear, periodMonth, entryDate }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || "Post failed");
      return;
    }
    setMessage(`Posted batch ${money(data.totalAmount)} for ${data.assetCount} assets.`);
    void loadPreview();
  }

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Depreciation</h1>
      </header>
      <div className="card grid gap-4 p-4 md:grid-cols-4">
        <label className="space-y-1">
          <span className="text-sm">Year</span>
          <input
            className="input w-full"
            type="number"
            value={periodYear}
            onChange={(e) => setPeriodYear(Number(e.target.value))}
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm">Month</span>
          <input
            className="input w-full"
            type="number"
            min="1"
            max="12"
            value={periodMonth}
            onChange={(e) => setPeriodMonth(Number(e.target.value))}
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm">Entry date</span>
          <input
            className="input w-full"
            type="date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
          />
        </label>
        <div className="flex items-end">
          <button type="button" className="btn btn-primary w-full" onClick={postBatch}>
            Post depreciation batch
          </button>
        </div>
      </div>
      {message ? <p className="text-sm">{message}</p> : null}
      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Asset</th>
              <th>Name</th>
              <th className="text-right">Calculated</th>
              <th>Posted</th>
            </tr>
          </thead>
          <tbody>
            {(preview?.rows ?? []).map((row) => (
              <tr key={row.assetNumber}>
                <td>{row.assetNumber}</td>
                <td>{row.name}</td>
                <td className="text-right font-tabular">{money(row.calculatedAmount)}</td>
                <td>{row.posted ? "Yes" : "Ready"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {preview ? (
          <div className="border-t px-4 py-3 text-sm">
            Total calculated {money(preview.totalCalculated)} · Ready to post{" "}
            {money(preview.totalReadyToPost)}
          </div>
        ) : null}
      </div>
    </div>
  );
}
