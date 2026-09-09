import Link from "next/link";
import { money } from "@/lib/format";
import { loadAccountantPlanningPackage } from "@/lib/planning/accountant-package/load-accountant-planning-package";
import { routes } from "@/lib/routes";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function ClosePlanningContextPanel({
  supabase,
  organizationId,
  periodEnd,
  periodLabel,
  fiscalYear,
}: {
  supabase: SupabaseClient;
  organizationId: string;
  periodEnd: string;
  periodLabel: string;
  fiscalYear: number;
}) {
  const pkg = await loadAccountantPlanningPackage(supabase, organizationId, {
    periodEnd,
    periodLabel,
    fiscalYear,
  });

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">Planning context (informational)</h2>
          <p className="mt-1 text-sm text-muted">
            Read-only summary for close review. Does not affect close eligibility or post to the GL.
          </p>
        </div>
        <Link
          href={`${routes.reports}?tab=planning&period=ytd`}
          className="text-sm text-sky hover:underline"
        >
          Full planning package
        </Link>
      </div>

      <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">Budget vs actual (OI YTD)</dt>
          <dd className="font-ledger">
            {pkg.budgetVsActual.operatingIncome
              ? money(pkg.budgetVsActual.operatingIncome.ytd.varianceAmount)
              : "—"}
          </dd>
          <dd className="text-xs text-muted capitalize">
            {pkg.budgetVsActual.available === "missing"
              ? "No budget"
              : pkg.budgetVsActual.operatingIncome?.ytd.status.replace(/_/g, " ") ?? "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Forecast operating income</dt>
          <dd className="font-ledger">
            {pkg.forecast.available === "ready"
              ? money(pkg.forecast.expectedOperatingIncome ?? 0)
              : "—"}
          </dd>
          <dd className="text-xs text-muted">
            {pkg.forecast.stale ? "Stale forecast" : pkg.forecast.available === "ready" ? "Current" : "No forecast"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Cash ending (13-week)</dt>
          <dd className="font-ledger">
            {pkg.cash.available === "ready" ? money(pkg.cash.endingCash ?? 0) : "—"}
          </dd>
          <dd className="text-xs text-muted">
            {pkg.cash.firstNegativeWeekIndex != null
              ? `Shortfall week ${pkg.cash.firstNegativeWeekIndex}`
              : pkg.cash.available === "ready"
                ? "No projected shortfall"
                : "Not generated"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Items to review</dt>
          <dd className="font-ledger">{pkg.risks.length}</dd>
          <dd className="text-xs text-muted">
            {pkg.sourceMismatches.length ? "Source mismatch flagged" : "Sources aligned"}
          </dd>
        </div>
      </dl>

      {pkg.risks.length ? (
        <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-muted">
          {pkg.risks.slice(0, 3).map((risk) => (
            <li key={risk.code}>{risk.message}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
