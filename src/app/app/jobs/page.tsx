import Link from "next/link";
import { JobForm } from "@/components/JobForm";
import { StatusBadge } from "@/components/StatusBadge";
import { money } from "@/lib/format";
import { getSessionContext, hasModule, label } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { jobPath, routes } from "@/lib/routes";
import { redirect } from "next/navigation";

export default async function JobsPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  if (!hasModule(session.settings, "jobs")) redirect(routes.app);

  const supabase = await createClient();
  const { data } = await supabase
    .from("teller_jobs")
    .select("*")
    .eq("organization_id", session.organization.id)
    .order("created_at", { ascending: false });

  const { data: parties } = await supabase
    .from("teller_parties")
    .select("id, name")
    .eq("organization_id", session.organization.id);
  const names = new Map((parties ?? []).map((row) => [row.id, row.name]));

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>{label(session.settings, "job", "Jobs")}</h1>
      </header>
      <JobForm customers={parties ?? []} />
      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Customer</th>
              <th>Type</th>
              <th>Status</th>
              <th className="text-right">Quoted</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((job) => (
              <tr key={job.id}>
                <td>
                  <Link href={jobPath(job.id)} className="font-medium hover:text-sky">
                    {job.job_number}
                  </Link>
                  <span className="text-muted"> · {job.name}</span>
                </td>
                <td>{job.party_id ? names.get(job.party_id) : "—"}</td>
                <td>{job.job_type}</td>
                <td>
                  <StatusBadge status={job.status} />
                </td>
                <td className="text-right font-tabular">{money(job.quoted_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
