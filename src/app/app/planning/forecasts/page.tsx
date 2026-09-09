import { ForecastListPanel } from "@/components/planning/ForecastListPanel";
import { planningOwnerLabel } from "@/lib/planning/presentation-labels";
import { routes } from "@/lib/routes";
import Link from "next/link";

export default function ForecastsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={routes.planning} className="text-sm text-muted-foreground hover:underline">
            ← Planning
          </Link>
          <h1 className="text-2xl font-semibold">{planningOwnerLabel("Forecast")}s</h1>
        </div>
        <Link
          href={routes.planningForecastNew}
          className="rounded-md bg-navy px-4 py-2 text-sm text-white"
        >
          New forecast
        </Link>
      </div>
      <ForecastListPanel />
    </div>
  );
}
