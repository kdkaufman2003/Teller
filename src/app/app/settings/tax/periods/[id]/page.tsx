import { redirect } from "next/navigation";
import { TaxFilingPeriodDetailView } from "@/components/TaxFilingPeriodDetailView";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";

type Params = { params: Promise<{ id: string }> };

export default async function TaxFilingPeriodDetailPage({ params }: Params) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const { id } = await params;
  return <TaxFilingPeriodDetailView periodId={id} />;
}
