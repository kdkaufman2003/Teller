"use client";

import { useState } from "react";
import { reopenReconciliation } from "@/lib/banking/reconciliation-client";
import type { ReconciliationWorkspacePayload } from "@/lib/banking/types";

type Props = {
  reconciliationId: string;
  onReopened: (workspace: ReconciliationWorkspacePayload) => void;
};

export function ReopenReconciliationDialog({ reconciliationId, onReopened }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!reason.trim()) {
      setError("A reason is required to reopen this reconciliation.");
      return;
    }
    setPending(true);
    setError("");
    try {
      const workspace = await reopenReconciliation({ reconciliationId, reason: reason.trim() });
      onReopened(workspace);
      setOpen(false);
      setReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reopen reconciliation");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-secondary w-full" onClick={() => setOpen(true)}>
        Reopen reconciliation
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/40 p-4">
          <form
            onSubmit={(event) => void handleSubmit(event)}
            className="card max-w-lg w-full p-6"
            role="dialog"
            aria-modal="true"
          >
            <h3 className="font-ledger text-xl text-navy">Reopen reconciliation</h3>
            <p className="mt-2 text-sm text-muted">
              Reopening allows changes to cleared transactions. A reason is required and will be
              recorded in the audit trail.
            </p>
            <label htmlFor="reopen-reason" className="mt-4 block text-sm font-semibold text-muted">
              Reason for reopening
            </label>
            <textarea
              id="reopen-reason"
              required
              rows={4}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Missing transaction discovered, statement balance entered incorrectly…"
              className="mt-1"
            />
            {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={pending}>
                {pending ? "Reopening…" : "Reopen"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
