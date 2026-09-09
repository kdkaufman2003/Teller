import { CashOutlookView } from "@/components/planning/CashOutlookView";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

export default async function CashOutlookPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const asOfDate = new Date().toISOString().slice(0, 10);

  return (
    <div className="p-6">
      <CashOutlookView initialAsOfDate={asOfDate} />
    </div>
  );
}
