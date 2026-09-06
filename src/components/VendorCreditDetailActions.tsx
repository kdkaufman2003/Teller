"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function VendorCreditDetailActions({
  id,
  status,
  unapplied,
  openBills,
  allocations,
}: {
  id: string;
  status: string;
  unapplied: number;
  openBills: Array<{ id: string; number: string }>;
  allocations: Array<{ id: string; amount: number; target_document_id: string }>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [targetId, setTargetId] = useState(openBills[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [reverseId, setReverseId] = useState("");
  const [reason, setReason] = useState("");

  async function post(action: string, body: Record<string, unknown> = {}) {
    setError("");
    setPending(true);
    try {
      const response = await fetch(`/api/vendor-credits/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Action failed");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {status === "draft" ? (
          <button className="btn btn-brass" disabled={pending} onClick={() => void post("post")}>
            Post credit
          </button>
        ) : null}
        {(status === "open" || status === "partially_applied") && unapplied > 0.009 ? (
          <>
            <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {openBills.map((bill) => (
                <option key={bill.id} value={bill.id}>
                  {bill.number}
                </option>
              ))}
            </select>
            <input
              type="number"
              min="0.01"
              max={unapplied}
              step="0.01"
              placeholder="Amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <button
              className="btn btn-brass"
              disabled={pending}
              onClick={() =>
                void post("apply", {
                  targetDocumentId: targetId,
                  amount: Number(amount),
                })
              }
            >
              Apply to bill
            </button>
          </>
        ) : null}
      </div>

      {allocations.length ? (
        <div className="card p-4 space-y-3 text-sm">
          <h3 className="font-medium">Reverse application</h3>
          <select value={reverseId} onChange={(event) => setReverseId(event.target.value)}>
            <option value="">Select allocation…</option>
            {allocations.map((row) => (
              <option key={row.id} value={row.id}>
                ${row.amount.toFixed(2)} → bill {row.target_document_id.slice(0, 8)}…
              </option>
            ))}
          </select>
          <input
            placeholder="Reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            className="btn btn-ghost"
            disabled={pending || !reverseId || !reason.trim()}
            onClick={() =>
              void post("reverse_application", {
                allocationId: reverseId,
                reason,
              })
            }
          >
            Reverse application
          </button>
        </div>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
