import { PlanningDashboardView } from "@/components/planning/PlanningDashboardView";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { redirect } from "next/navigation";

export default async function PlanningDashboardPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const asOfDate = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <PlanningDashboardView initialAsOfDate={asOfDate} />
    </div>
  );
}
