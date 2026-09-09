"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { defaultAnchorMonth } from "@/lib/planning/forecasts/periods";
import { planningOwnerLabel } from "@/lib/planning/presentation-labels";
import { forecastPath, routes } from "@/lib/routes";

type BudgetOption = {
  id: string;
  fiscal_year: number;
  name: string;
  teller_budget_versions: Array<{
    id: string;
    version_number: number;
    label: string;
    status: string;
  }>;
};

export function NewForecastForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [anchorMonth, setAnchorMonth] = useState(defaultAnchorMonth().slice(0, 7));
  const [baselineKind, setBaselineKind] = useState<"blank" | "budget">("blank");
  const [budgetVersionId, setBudgetVersionId] = useState("");
  const [budgets, setBudgets] = useState<BudgetOption[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/planning/budgets")
      .then((response) => response.json())
      .then((data) => setBudgets((data.budgets ?? []) as BudgetOption[]));
  }, []);

  const budgetVersions = budgets.flatMap((budget) =>
    (budget.teller_budget_versions ?? []).map((version) => ({
      ...version,
      budgetName: budget.name,
      fiscalYear: budget.fiscal_year,
    })),
  );

  async function createForecast() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/planning/forecasts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          anchorMonth: `${anchorMonth}-01`,
          baselineKind,
          sourceBudgetVersionId: baselineKind === "budget" ? budgetVersionId : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create forecast");
      router.push(forecastPath(data.forecast.id as string));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create forecast");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <div>
        <Link href={routes.planningForecasts} className="text-sm text-muted-foreground hover:underline">
          ← {planningOwnerLabel("Forecast")}s
        </Link>
        <h1 className="text-2xl font-semibold">New {planningOwnerLabel("Forecast").toLowerCase()}</h1>
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <div className="space-y-4 rounded-lg border p-4">
        <label className="block text-sm">
          Name
          <input
            className="mt-1 w-full rounded border px-3 py-2"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Rolling forecast"
          />
        </label>

        <label className="block text-sm">
          As-of month
          <input
            type="month"
            className="mt-1 w-full rounded border px-3 py-2"
            value={anchorMonth}
            onChange={(event) => setAnchorMonth(event.target.value)}
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
            Start blank
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={baselineKind === "budget"}
              onChange={() => setBaselineKind("budget")}
            />
            Start from budget
          </label>
        </fieldset>

        {baselineKind === "budget" ? (
          <label className="block text-sm">
            Budget version
            <select
              className="mt-1 w-full rounded border px-3 py-2"
              value={budgetVersionId}
              onChange={(event) => setBudgetVersionId(event.target.value)}
            >
              <option value="">Select budget version</option>
              {budgetVersions.map((version) => (
                <option key={version.id} value={version.id}>
                  FY{version.fiscalYear} {version.budgetName} · v{version.version_number} ({version.status})
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <button
          type="button"
          onClick={() => void createForecast()}
          disabled={pending || !name.trim() || (baselineKind === "budget" && !budgetVersionId)}
          className="rounded-md bg-navy px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create forecast"}
        </button>
      </div>
    </div>
  );
}
