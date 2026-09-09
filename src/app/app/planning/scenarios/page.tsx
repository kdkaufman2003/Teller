import Link from "next/link";
import { ScenarioListPanel } from "@/components/planning/ScenarioListPanel";
import { planningOwnerLabel } from "@/lib/planning/presentation-labels";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { redirect } from "next/navigation";

export default async function ScenariosPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{planningOwnerLabel("Scenarios")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Compare Base, Downside, Upside, and custom what-if plans without changing your books.
          </p>
        </div>
        <Link
          href={routes.planningScenarioNew}
          className="rounded-md bg-navy px-4 py-2 text-sm text-white"
        >
          New scenario
        </Link>
      </div>

      <ScenarioListPanel />

      <Link href={routes.planning} className="inline-block text-sm text-navy hover:underline">
        ← Planning hub
      </Link>
    </div>
  );
}
