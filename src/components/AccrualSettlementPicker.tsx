"use client";

import { useEffect, useMemo, useState } from "react";

export type EligibleAccrual = {
  occurrenceId: string;
  scheduleName: string;
  occurrenceDate: string;
  accruedAmount: number;
  remainingAmount: number;
  liabilityAccountId: string;
  expenseAccountId: string;
  settlementStatus: string;
};

export type AccrualAllocationSelection = {
  occurrenceId: string;
  appliedAmount: number;
};

export function AccrualSettlementPicker({
  partyId,
  billAmount,
  value,
  onChange,
}: {
  partyId?: string;
  billAmount: number;
  value: AccrualAllocationSelection[];
  onChange: (next: AccrualAllocationSelection[]) => void;
}) {
  const [eligible, setEligible] = useState<EligibleAccrual[]>([]);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{
    varianceAmount: number;
    estimatedApplied: number;
    apAmount: number;
  } | null>(null);

  useEffect(() => {
    if (!partyId) {
      void Promise.resolve().then(() => {
        setEligible([]);
        setLoading(false);
      });
      return;
    }
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) setLoading(true);
    });
    fetch(`/api/accounting/accrual-settlements/eligible?partyId=${encodeURIComponent(partyId)}`)
      .then((res) => res.json())
      .then((data: { eligible?: EligibleAccrual[] }) => {
        if (!cancelled) setEligible(data.eligible ?? []);
      })
      .catch(() => {
        if (!cancelled) setEligible([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [partyId]);

  const selectedTotal = useMemo(
    () => value.reduce((sum, row) => sum + row.appliedAmount, 0),
    [value],
  );

  useEffect(() => {
    if (!value.length || billAmount <= 0) {
      void Promise.resolve().then(() => setPreview(null));
      return;
    }
    fetch("/api/accounting/accrual-settlements/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        partyId,
        tax: 0,
        lines: [{ amount: billAmount, description: "Bill" }],
        allocations: value,
      }),
    })
      .then((res) => res.json())
      .then((data: { preview?: { varianceAmount: number; estimatedApplied: number; apAmount: number } }) =>
        setPreview(data.preview ?? null),
      )
      .catch(() => setPreview(null));
  }, [value, billAmount, partyId]);

  function toggle(row: EligibleAccrual) {
    const exists = value.find((item) => item.occurrenceId === row.occurrenceId);
    if (exists) {
      onChange(value.filter((item) => item.occurrenceId !== row.occurrenceId));
      return;
    }
    onChange([...value, { occurrenceId: row.occurrenceId, appliedAmount: row.remainingAmount }]);
  }

  if (!partyId) {
    return (
      <p className="text-sm text-muted-foreground">
        Select a vendor to apply existing accruals when the bill arrives.
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div>
        <h3 className="text-sm font-medium">Apply existing accrual</h3>
        <p className="text-xs text-muted-foreground">
          Clears accrued liability and recognizes only the estimate-to-actual variance.
        </p>
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading eligible accruals…</p>
      ) : eligible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No posted unsettled accruals for this vendor.</p>
      ) : (
        <ul className="space-y-2">
          {eligible.map((row) => {
            const selected = value.some((item) => item.occurrenceId === row.occurrenceId);
            return (
              <li key={row.occurrenceId} className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggle(row)}
                  className="mt-1"
                />
                <div>
                  <p className="font-medium">{row.scheduleName}</p>
                  <p className="text-muted-foreground">
                    {row.occurrenceDate} · ${row.remainingAmount.toFixed(2)} remaining of $
                    {row.accruedAmount.toFixed(2)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {preview ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-sm">
          <p>Accrual applied: ${preview.estimatedApplied.toFixed(2)}</p>
          <p>Variance expense: ${preview.varianceAmount.toFixed(2)}</p>
          <p>Accounts payable: ${preview.apAmount.toFixed(2)}</p>
          <p className="text-muted-foreground">Selected accrual total: ${selectedTotal.toFixed(2)}</p>
        </div>
      ) : null}
    </div>
  );
}
