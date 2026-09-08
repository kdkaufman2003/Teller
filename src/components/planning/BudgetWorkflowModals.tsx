"use client";

import { money } from "@/lib/format";
import type { ApprovalReviewSummary } from "@/lib/planning/budgets/approval-review";

export function BudgetApprovalModal({
  review,
  pending,
  onConfirm,
  onCancel,
}: {
  review: ApprovalReviewSummary;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border bg-paper-strong p-6 shadow-lg">
        <h2 className="text-lg font-semibold">Review before approval</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Approved plans become read-only. You can create a revision later if needed.
        </p>

        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Plan name</dt>
            <dd className="font-medium">{review.budgetName}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Fiscal year</dt>
            <dd>FY{review.fiscalYear}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Version</dt>
            <dd>
              v{review.versionNumber}
              {review.versionLabel ? ` · ${review.versionLabel}` : ""}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Annual total</dt>
            <dd className="font-ledger">{money(review.annualTotal)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Accounts with values</dt>
            <dd>{review.accountCount}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Months with values</dt>
            <dd>{review.monthsWithValues}</dd>
          </div>
        </dl>

        {review.warnings.length ? (
          <ul className="mt-4 space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            {review.warnings.map((warning) => (
              <li key={warning}>• {warning}</li>
            ))}
          </ul>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-md border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || !review.canApprove}
            onClick={onConfirm}
            className="rounded-md bg-navy px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {pending ? "Approving…" : "Approve plan"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BudgetLockConfirmModal({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg border bg-paper-strong p-6 shadow-lg">
        <h2 className="text-lg font-semibold">Lock this plan version?</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Locking preserves this approved plan as historical truth. It cannot be edited. Create a
          revision to make changes.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-md border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className="rounded-md bg-navy px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {pending ? "Locking…" : "Lock plan"}
          </button>
        </div>
      </div>
    </div>
  );
}
