import { JobForm } from "@/components/JobForm";
import { StatusBadge } from "@/components/StatusBadge";
import { money } from "@/lib/format";
import { getSessionContext, hasModule, label } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
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
      <h1 className="font-ledger text-4xl text-navy">
        {label(session.settings, "job", "Jobs")}
      </h1>
      <JobForm customers={parties ?? []} />
      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-paper text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Job</th>
              <th className="px-4 py-3 font-medium">Customer</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Quoted</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((job) => (
              <tr key={job.id} className="border-t border-rule">
                <td className="px-4 py-3">
                  <span className="font-medium">{job.job_number}</span>
                  <span className="text-muted"> · {job.name}</span>
                </td>
                <td className="px-4 py-3">
                  {job.party_id ? names.get(job.party_id) : "—"}
                </td>
                <td className="px-4 py-3">{job.job_type}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={job.status} />
                </td>
                <td className="px-4 py-3 text-right font-tabular">
                  {money(job.quoted_amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
