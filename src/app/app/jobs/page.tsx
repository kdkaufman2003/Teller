import Link from "next/link";
import { redirect } from "next/navigation";
import { buildJobProfitabilitySummary } from "@/lib/accounting/job-profitability";
import { money } from "@/lib/format";
import { jobPath, routes } from "@/lib/routes";
import { getSessionContext, hasModule, label } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { StatusBadge } from "@/components/StatusBadge";

export default async function JobsPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  if (!hasModule(session.settings, "jobs")) redirect(routes.app);

  const supabase = await createClient();
  const organizationId = session.organization.id;
  const { data: jobs } = await supabase
    .from("teller_jobs")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  const { data: parties } = await supabase
    .from("teller_parties")
    .select("id, name")
    .eq("organization_id", organizationId);
  const partyNames = new Map((parties ?? []).map((row) => [row.id, row.name as string]));

  const rows = await Promise.all(
    (jobs ?? []).map(async (job) => {
      const profitability = await buildJobProfitabilitySummary(supabase, organizationId, job.id as string);
      return { job, profitability };
    }),
  );

  return (
    <div className="space-y-6">
      <header className="page-header flex items-center justify-between gap-4">
        <h1>{label(session.settings, "job", "Jobs")}</h1>
        <div className="flex gap-2">
          <Link href={routes.jobsUnassigned} className="btn btn-secondary">
            Unassigned activity
          </Link>
          <Link href={routes.jobNew} className="btn btn-primary">
            New job
          </Link>
        </div>
      </header>
      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Customer</th>
              <th>Status</th>
              <th className="text-right">Contract</th>
              <th className="text-right">Revenue</th>
              <th className="text-right">Actual</th>
              <th className="text-right">Committed</th>
              <th className="text-right">GP</th>
              <th className="text-right">AR</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ job, profitability }) => (
              <tr key={job.id}>
                <td>
                  <Link href={jobPath(job.id as string)} className="font-medium hover:text-sky">
                    {job.job_number}
                  </Link>
                  <span className="text-muted"> · {job.name}</span>
                </td>
                <td>{job.party_id ? partyNames.get(job.party_id as string) : "—"}</td>
                <td>
                  <StatusBadge status={job.status as string} />
                </td>
                <td className="text-right font-tabular">
                  {money(profitability.revisedContractAmount ?? profitability.originalContractAmount)}
                </td>
                <td className="text-right font-tabular">{money(profitability.recognizedRevenue)}</td>
                <td className="text-right font-tabular">{money(profitability.actualDirectCost)}</td>
                <td className="text-right font-tabular">{money(profitability.remainingCommittedCost)}</td>
                <td className="text-right font-tabular">{money(profitability.grossProfit)}</td>
                <td className="text-right font-tabular">{money(profitability.accountsReceivable)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
