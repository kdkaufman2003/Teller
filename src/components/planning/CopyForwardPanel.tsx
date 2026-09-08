"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { routes } from "@/lib/routes";

export function CopyForwardPanel({
  budgetId,
  sourceVersionId,
  sourceFiscalYear,
}: {
  budgetId: string;
  sourceVersionId: string;
  sourceFiscalYear: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${sourceFiscalYear + 1} Operating Budget`);
  const [targetFiscalYear, setTargetFiscalYear] = useState(sourceFiscalYear + 1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/planning/budgets/${budgetId}/copy-forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceVersionId, targetFiscalYear, name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Copy failed");
      router.push(`${routes.planningBudgets}/${data.budget.id}?version=${data.version.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Copy failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="rounded-md border px-4 py-2 text-sm">
        Copy to next year
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg border bg-paper-strong p-6 shadow-lg">
            <h2 className="text-lg font-semibold">Copy plan to a new fiscal year</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Creates a new draft budget with months shifted to the target year.
            </p>
            <label className="mt-4 block text-sm">
              New plan name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-1 w-full rounded border px-3 py-2"
              />
            </label>
            <label className="mt-3 block text-sm">
              Target fiscal year
              <input
                type="number"
                value={targetFiscalYear}
                onChange={(event) => setTargetFiscalYear(Number(event.target.value))}
                className="mt-1 w-full rounded border px-3 py-2"
              />
            </label>
            {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded-md border px-4 py-2 text-sm">
                Cancel
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => void submit()}
                className="rounded-md bg-navy px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {pending ? "Copying…" : "Create copy"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
