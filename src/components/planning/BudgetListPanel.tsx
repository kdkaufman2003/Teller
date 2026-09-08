"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { planningOwnerLabel } from "@/lib/planning/presentation-labels";
import { routes, planningBudgetPath } from "@/lib/routes";

type BudgetRow = {
  id: string;
  name: string;
  fiscal_year: number;
  status: string;
  teller_budget_versions?: { id: string; version_number: number; status: string }[];
};

export function BudgetListPanel() {
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [schemaReady, setSchemaReady] = useState(true);

  useEffect(() => {
    void fetch("/api/planning/budgets")
      .then((r) => r.json())
      .then((data: { budgets?: BudgetRow[]; schemaReady?: boolean }) => {
        setBudgets(data.budgets ?? []);
        setSchemaReady(data.schemaReady !== false);
      });
  }, []);

  if (!schemaReady) {
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        Apply migration 032 to enable {planningOwnerLabel("Budget")} planning.
      </p>
    );
  }

  if (!budgets.length) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <h2 className="text-lg font-medium">No budget yet</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Create your first annual plan to set monthly targets and compare your business against
          them.
        </p>
        <Link
          href={routes.planningBudgetNew}
          className="mt-4 inline-block rounded-md bg-navy px-4 py-2 text-sm text-white"
        >
          Create {planningOwnerLabel("Budget")}
        </Link>
      </div>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {budgets.map((budget) => {
        const latest = budget.teller_budget_versions?.[0];
        return (
          <li key={budget.id}>
            <Link
              href={planningBudgetPath(budget.id)}
              className="flex items-center justify-between px-4 py-3 hover:bg-muted/30"
            >
              <div>
                <p className="font-medium">{budget.name}</p>
                <p className="text-sm text-muted-foreground">FY{budget.fiscal_year}</p>
              </div>
              {latest ? (
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  v{latest.version_number} · {latest.status}
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
