"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CloseReadinessReport } from "@/lib/accounting/close-readiness";

export function ClosePeriodActions({
  periodEnd,
  readiness,
}: {
  periodEnd: string;
  readiness: CloseReadinessReport;
}) {
  const router = useRouter();
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function closePeriod() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/accounting/periods/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodEnd,
          notes,
          warningsAcknowledged: readiness.findings
            .filter((f) => f.severity === "warning")
            .map((f) => f.key),
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not close period");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close period");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card space-y-3 p-4">
      <h2 className="font-medium">Close period</h2>
      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          {error}
        </p>
      ) : null}
      {readiness.blockerCount > 0 ? (
        <p className="text-sm text-muted">
          Resolve {readiness.blockerCount} blocker
          {readiness.blockerCount === 1 ? "" : "s"} before closing.
        </p>
      ) : (
        <>
          <label className="block text-sm">
            <span className="text-muted">Notes (optional)</span>
            <input
              className="input mt-1 w-full"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            onClick={closePeriod}
          >
            {pending ? "Closing…" : `Close through ${periodEnd}`}
          </button>
        </>
      )}
    </div>
  );
}
