import { ScheduleDetailView } from "@/components/ScheduleViews";
import { canPostAdjustments } from "@/lib/accounting/cpa";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

type PageProps = { params: Promise<{ id: string }> };

export default async function ScheduleDetailPage({ params }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const { id } = await params;
  const role = session.profile?.role ?? "viewer";

  return <ScheduleDetailView scheduleId={id} canWrite={canPostAdjustments(role)} />;
}
