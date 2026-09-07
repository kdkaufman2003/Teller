"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function AdjustmentActions({
  adjustmentId,
  status,
  entryDate,
}: {
  adjustmentId: string;
  status: string;
  entryDate: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [reversalDate, setReversalDate] = useState(entryDate);
  const [reason, setReason] = useState("");

  async function runAction(action: "post" | "reverse") {
    setPending(action);
    setError("");
    try {
      const body =
        action === "reverse"
          ? { action, reversalDate, reason }
          : { action: "post" };

      const response = await fetch(`/api/accounting/adjustments/${adjustmentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Action failed");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setPending("");
    }
  }

  return (
    <div className="card space-y-3 p-4">
      <h2 className="font-medium">Actions</h2>
      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          {error}
        </p>
      ) : null}

      {["draft", "submitted", "approved"].includes(status) ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={Boolean(pending)}
          onClick={() => runAction("post")}
        >
          {pending === "post" ? "Posting…" : "Post to ledger"}
        </button>
      ) : null}

      {status === "posted" ? (
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="text-muted">Reversal date</span>
            <input
              type="date"
              className="input mt-1 w-full"
              value={reversalDate}
              onChange={(event) => setReversalDate(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Reason</span>
            <input
              className="input mt-1 w-full"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this being reversed?"
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={Boolean(pending) || !reason.trim()}
            onClick={() => runAction("reverse")}
          >
            {pending === "reverse" ? "Reversing…" : "Reverse entry"}
          </button>
        </div>
      ) : null}

      {status === "reversed" ? (
        <p className="text-sm text-muted">This adjustment has been reversed.</p>
      ) : null}
    </div>
  );
}
