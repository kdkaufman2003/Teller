"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDate, money, titleCase } from "@/lib/format";
import {
  canFinalize,
  finalizeReconciliation,
  toggleReconciliationItem,
} from "@/lib/banking/reconciliation-client";
import type { ReconciliationCandidate, ReconciliationWorkspacePayload } from "@/lib/banking/types";
import { EDITABLE_RECONCILIATION_STATUSES } from "@/lib/banking/types";
import { bankingReconciliationPath, routes } from "@/lib/routes";
import { ReconciliationSummaryCard } from "./ReconciliationSummaryCard";
import { ReopenReconciliationDialog } from "./ReopenReconciliationDialog";

type Filter = "all" | "money_in" | "money_out" | "cleared" | "uncleared";

type Props = {
  initialWorkspace: ReconciliationWorkspacePayload;
  canWrite: boolean;
  completedView?: boolean;
};

export function ReconciliationWorkspace({
  initialWorkspace,
  canWrite,
  completedView = false,
}: Props) {
  const router = useRouter();
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [bookkeeperMode, setBookkeeperMode] = useState(false);
  const [pendingTxnId, setPendingTxnId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [pendingFinalize, setPendingFinalize] = useState(false);

  const editable =
    canWrite &&
    EDITABLE_RECONCILIATION_STATUSES.includes(
      workspace.reconciliation.status as (typeof EDITABLE_RECONCILIATION_STATUSES)[number],
    );

  const accountLabel = `${workspace.bankAccount.name}${
    workspace.bankAccount.mask ? ` •••${workspace.bankAccount.mask}` : ""
  }`;

  const filteredCandidates = useMemo(() => {
    return workspace.candidates.filter((candidate) => {
      if (search.trim()) {
        const needle = search.trim().toLowerCase();
        if (!candidate.description.toLowerCase().includes(needle)) return false;
      }
      if (filter === "money_in" && candidate.moneyIn <= 0) return false;
      if (filter === "money_out" && candidate.moneyOut <= 0) return false;
      if (filter === "cleared" && !candidate.cleared) return false;
      if (filter === "uncleared" && candidate.cleared) return false;
      return true;
    });
  }, [workspace.candidates, search, filter]);

  const refreshWorkspace = useCallback((next: ReconciliationWorkspacePayload) => {
    setWorkspace(next);
    setNotice("Reconciliation updated.");
  }, []);

  async function handleToggle(candidate: ReconciliationCandidate, cleared: boolean) {
    if (!editable || candidate.lockedElsewhere) return;
    setError("");
    setNotice("");
    setPendingTxnId(candidate.bankTransactionId);
    try {
      const next = await toggleReconciliationItem({
        reconciliationId: workspace.reconciliation.id,
        bankTransactionId: candidate.bankTransactionId,
        cleared,
      });
      refreshWorkspace(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update cleared state");
    } finally {
      setPendingTxnId(null);
    }
  }

  async function handleBulk(cleared: boolean) {
    if (!editable) return;
    setError("");
    setNotice("");
    let latest = workspace;
    for (const candidate of filteredCandidates) {
      if (candidate.lockedElsewhere) continue;
      if (candidate.cleared === cleared) continue;
      setPendingTxnId(candidate.bankTransactionId);
      try {
        latest = await toggleReconciliationItem({
          reconciliationId: workspace.reconciliation.id,
          bankTransactionId: candidate.bankTransactionId,
          cleared,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Bulk update failed");
        break;
      }
    }
    refreshWorkspace(latest);
    setPendingTxnId(null);
  }

  async function handleFinalize() {
    if (!editable || !canFinalize(workspace.summary)) return;
    setPendingFinalize(true);
    setError("");
    try {
      const next = await finalizeReconciliation(workspace.reconciliation.id);
      setWorkspace(next);
      router.push(`${routes.bankingReconcile}/${workspace.reconciliation.id}?completed=1`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish reconciliation");
    } finally {
      setPendingFinalize(false);
      setConfirmFinalize(false);
    }
  }

  return (
    <div className="space-y-6">
      {notice ? <p className="text-sm text-ok">{notice}</p> : null}
      {error ? (
        <p className="rounded-lg border border-danger/30 bg-paper-strong p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4 order-2 xl:order-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {(["all", "money_in", "money_out", "cleared", "uncleared"] as Filter[]).map(
                (value) => (
                  <button
                    key={value}
                    type="button"
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      filter === value
                        ? "bg-navy text-white"
                        : "border border-rule bg-paper-strong text-muted"
                    }`}
                    onClick={() => setFilter(value)}
                  >
                    {value === "money_in"
                      ? "Money in"
                      : value === "money_out"
                        ? "Money out"
                        : titleCase(value)}
                  </button>
                ),
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={bookkeeperMode}
                onChange={(event) => setBookkeeperMode(event.target.checked)}
              />
              Bookkeeper mode
            </label>
          </div>

          <input
            type="search"
            placeholder="Search description"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search transactions"
          />

          {editable ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={Boolean(pendingTxnId)}
                onClick={() => void handleBulk(true)}
              >
                Clear all visible
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={Boolean(pendingTxnId)}
                onClick={() => void handleBulk(false)}
              >
                Unclear all visible
              </button>
            </div>
          ) : null}

          <div className="card overflow-hidden">
            <div className="hidden md:block">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Cleared</th>
                    <th scope="col">Date</th>
                    <th scope="col">Description</th>
                    <th scope="col">Type</th>
                    <th scope="col" className="text-right">
                      Money out
                    </th>
                    <th scope="col" className="text-right">
                      Money in
                    </th>
                    {bookkeeperMode ? <th scope="col">Status</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {filteredCandidates.map((candidate) => (
                    <TransactionRow
                      key={candidate.bankTransactionId}
                      candidate={candidate}
                      bookkeeperMode={bookkeeperMode}
                      editable={editable}
                      pending={pendingTxnId === candidate.bankTransactionId}
                      onToggle={(cleared) => void handleToggle(candidate, cleared)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="divide-y divide-rule md:hidden">
              {filteredCandidates.map((candidate) => (
                <li key={candidate.bankTransactionId} className="p-4">
                  <TransactionCard
                    candidate={candidate}
                    bookkeeperMode={bookkeeperMode}
                    editable={editable}
                    pending={pendingTxnId === candidate.bankTransactionId}
                    onToggle={(cleared) => void handleToggle(candidate, cleared)}
                  />
                </li>
              ))}
            </ul>

            {!filteredCandidates.length ? (
              <p className="p-4 text-sm text-muted">No transactions match your filters.</p>
            ) : null}
          </div>
        </div>

        <div className="order-1 xl:order-2 space-y-4">
          <ReconciliationSummaryCard
            summary={workspace.summary}
            accountLabel={accountLabel}
            statementEndDate={formatDate(workspace.reconciliation.statementEndDate)}
          />

          {editable ? (
            <>
              <button
                type="button"
                className="btn btn-primary w-full"
                disabled={!canFinalize(workspace.summary) || pendingFinalize}
                onClick={() => setConfirmFinalize(true)}
              >
                Finish reconciliation
              </button>
              {!canFinalize(workspace.summary) ? (
                <p className="text-xs text-muted">
                  Finish is available when the difference is $0.00.
                </p>
              ) : null}
            </>
          ) : completedView && workspace.reconciliation.status === "completed" && canWrite ? (
            <ReopenReconciliationDialog
              reconciliationId={workspace.reconciliation.id}
              onReopened={refreshWorkspace}
            />
          ) : null}

          <Link href={bankingReconciliationPath(workspace.reconciliation.id)} className="btn btn-secondary w-full">
            View reconciliation details
          </Link>
        </div>
      </div>

      {confirmFinalize ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/40 p-4">
          <div className="card max-w-md w-full p-6" role="dialog" aria-modal="true">
            <h3 className="font-ledger text-xl text-navy">Finish reconciliation?</h3>
            <p className="mt-2 text-sm text-muted">
              {accountLabel}
              <br />
              Statement ending: {formatDate(workspace.reconciliation.statementEndDate)}
              <br />
              Statement balance: {money(workspace.summary.statementEndingBalance)}
              <br />
              Difference: {money(workspace.summary.difference)}
            </p>
            <p className="mt-3 text-sm">
              Once finished, this reconciliation will be locked until reopened with a reason.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmFinalize(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={pendingFinalize}
                onClick={() => void handleFinalize()}
              >
                {pendingFinalize ? "Finishing…" : "Finish"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TransactionRow({
  candidate,
  bookkeeperMode,
  editable,
  pending,
  onToggle,
}: {
  candidate: ReconciliationCandidate;
  bookkeeperMode: boolean;
  editable: boolean;
  pending: boolean;
  onToggle: (cleared: boolean) => void;
}) {
  const checkboxId = `cleared-${candidate.bankTransactionId}`;
  return (
    <tr className={candidate.lockedElsewhere ? "opacity-60" : undefined}>
      <td>
        <input
          id={checkboxId}
          type="checkbox"
          checked={candidate.cleared}
          disabled={!editable || pending || candidate.lockedElsewhere}
          aria-label={`Clear ${candidate.description}`}
          onChange={(event) => onToggle(event.target.checked)}
        />
      </td>
      <td>{formatDate(candidate.postedDate)}</td>
      <td>
        <label htmlFor={checkboxId} className="cursor-pointer">
          {candidate.description}
        </label>
        {candidate.provider ? (
          <p className="text-xs text-muted">Bank feed · {candidate.provider}</p>
        ) : null}
      </td>
      <td>{titleCase(candidate.status)}</td>
      <td className="text-right font-tabular">
        {candidate.moneyOut > 0 ? money(candidate.moneyOut) : "—"}
      </td>
      <td className="text-right font-tabular">
        {candidate.moneyIn > 0 ? money(candidate.moneyIn) : "—"}
      </td>
      {bookkeeperMode ? (
        <td className="text-xs text-muted">
          {candidate.reconciliationItemId ? `Item ${candidate.reconciliationItemId.slice(0, 8)}` : "—"}
          {candidate.lockedElsewhere ? " · Locked elsewhere" : ""}
        </td>
      ) : null}
    </tr>
  );
}

function TransactionCard({
  candidate,
  bookkeeperMode,
  editable,
  pending,
  onToggle,
}: {
  candidate: ReconciliationCandidate;
  bookkeeperMode: boolean;
  editable: boolean;
  pending: boolean;
  onToggle: (cleared: boolean) => void;
}) {
  const checkboxId = `mobile-cleared-${candidate.bankTransactionId}`;
  return (
    <div className="flex gap-3">
      <input
        id={checkboxId}
        type="checkbox"
        checked={candidate.cleared}
        disabled={!editable || pending || candidate.lockedElsewhere}
        aria-label={`Clear ${candidate.description}`}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-semibold">{candidate.description}</p>
            <p className="text-xs text-muted">{formatDate(candidate.postedDate)}</p>
          </div>
          <p className="font-tabular font-semibold">
            {candidate.moneyIn > 0 ? money(candidate.moneyIn) : money(-candidate.moneyOut)}
          </p>
        </div>
        {bookkeeperMode ? (
          <p className="mt-1 text-xs text-muted">
            {titleCase(candidate.status)}
            {candidate.provider ? ` · ${candidate.provider}` : ""}
          </p>
        ) : null}
      </div>
    </div>
  );
}
