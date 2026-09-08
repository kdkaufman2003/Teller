"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { planningOwnerLabel } from "@/lib/planning/presentation-labels";
import { routes } from "@/lib/routes";

export function NewBudgetForm() {
  const router = useRouter();
  const currentYear = new Date().getFullYear();
  const [name, setName] = useState(`${currentYear + 1} Operating Budget`);
  const [fiscalYear, setFiscalYear] = useState(currentYear + 1);
  const [baselineKind, setBaselineKind] = useState<"blank" | "prior_year_actual">("blank");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/planning/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, fiscalYear, baselineKind }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create budget");
      router.push(`${routes.planningBudgets}/${data.budget.id}?version=${data.version.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create budget");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-lg space-y-4 rounded-lg border p-6">
      <h1 className="text-xl font-semibold">New {planningOwnerLabel("Budget")}</h1>
      <label className="block text-sm">
        Name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-1 w-full rounded border px-3 py-2"
          required
        />
      </label>
      <label className="block text-sm">
        Fiscal year
        <input
          type="number"
          value={fiscalYear}
          onChange={(event) => setFiscalYear(Number(event.target.value))}
          className="mt-1 w-full rounded border px-3 py-2"
          required
        />
      </label>
      <fieldset className="space-y-2 text-sm">
        <legend className="font-medium">Starting point</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={baselineKind === "blank"}
            onChange={() => setBaselineKind("blank")}
          />
          Blank
        </label>
        <label className="flex items-center gap-2 text-muted-foreground">
          <input
            type="radio"
            checked={baselineKind === "prior_year_actual"}
            onChange={() => setBaselineKind("prior_year_actual")}
            disabled
          />
          Prior-year actuals (coming in a later release)
        </label>
      </fieldset>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-navy px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create budget"}
        </button>
        <Link href={routes.planningBudgets} className="rounded-md border px-4 py-2 text-sm">
          Cancel
        </Link>
      </div>
    </form>
  );
}
