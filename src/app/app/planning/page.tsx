import Link from "next/link";
import { BudgetListPanel } from "@/components/planning/BudgetListPanel";
import { planningOwnerLabel } from "@/lib/planning/presentation-labels";
import { routes } from "@/lib/routes";

export default function PlanningHubPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Planning</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set monthly targets with your {planningOwnerLabel("Budget")}. Forecasting and cash outlook
          are coming in later releases.
        </p>
      </div>
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">{planningOwnerLabel("Budget")}s</h2>
          <Link href={routes.planningBudgetNew} className="text-sm text-navy underline-offset-2 hover:underline">
            New budget
          </Link>
        </div>
        <BudgetListPanel />
      </section>
      <section className="rounded-lg border p-4">
        <h2 className="text-lg font-medium">{planningOwnerLabel("Budget vs Actual")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          See how posted results compare to your approved plan.
        </p>
        <Link
          href={routes.planningBudgetVsActual}
          className="mt-3 inline-block rounded-md border px-4 py-2 text-sm"
        >
          Open report
        </Link>
      </section>
    </div>
  );
}
