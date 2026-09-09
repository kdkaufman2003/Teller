import { ScenarioDetailView } from "@/components/planning/ScenarioDetailView";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { redirect } from "next/navigation";

type PageProps = { params: Promise<{ id: string }> };

export default async function ScenarioDetailPage({ params }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const { id } = await params;

  return (
    <div className="p-6">
      <ScenarioDetailView scenarioId={id} />
    </div>
  );
}
