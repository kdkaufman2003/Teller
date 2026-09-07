import { OccurrenceReviewView } from "@/components/OccurrenceReviewView";
import { canPostAdjustments } from "@/lib/accounting/cpa";
import { booksClosedThrough } from "@/lib/accounting/periods";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

type PageProps = { params: Promise<{ id: string; occurrenceId: string }> };

export default async function OccurrenceReviewPage({ params }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const { id, occurrenceId } = await params;
  const role = session.profile?.role ?? "viewer";

  const supabase = await createClient();
  const { data: closes } = await supabase
    .from("teller_period_closes")
    .select("period_end, closed_at, event_type, effective_closed_through")
    .eq("organization_id", session.organization.id)
    .order("period_end", { ascending: false })
    .limit(24);

  const closedThrough = booksClosedThrough(closes ?? []);

  return (
    <OccurrenceReviewView
      scheduleId={id}
      occurrenceId={occurrenceId}
      canWrite={canPostAdjustments(role)}
      closedThrough={closedThrough}
    />
  );
}
