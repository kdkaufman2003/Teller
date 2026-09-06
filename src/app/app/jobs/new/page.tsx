import Link from "next/link";
import { redirect } from "next/navigation";
import { JobCreateForm } from "@/components/JobCreateForm";
import { routes } from "@/lib/routes";
import { getSessionContext, hasModule, label } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export default async function NewJobPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  if (!hasModule(session.settings, "jobs")) redirect(routes.app);

  const supabase = await createClient();
  const { data: customers } = await supabase
    .from("teller_parties")
    .select("id, name")
    .eq("organization_id", session.organization.id)
    .eq("kind", "customer");

  return (
    <div className="space-y-6">
      <header className="page-header">
        <p className="text-sm text-muted">
          <Link href={routes.jobs} className="text-sky">
            {label(session.settings, "job", "Jobs")}
          </Link>
        </p>
        <h1>New {label(session.settings, "jobSingular", "job")}</h1>
      </header>
      <JobCreateForm customers={customers ?? []} />
    </div>
  );
}
