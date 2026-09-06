import Link from "next/link";
import { redirect } from "next/navigation";
import { buildJobProfitabilitySummary } from "@/lib/accounting/job-profitability";
import { listUnassignedJobActivity } from "@/lib/accounting/unassigned-job-activity";
import { money } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getSessionContext, hasModule, label } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export default async function UnassignedJobActivityPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  if (!hasModule(session.settings, "jobs")) redirect(routes.app);

  const supabase = await createClient();
  const rows = await listUnassignedJobActivity(supabase, session.organization.id);

  return (
    <div className="space-y-6">
      <header className="page-header">
        <p className="text-sm text-muted">
          <Link href={routes.jobs} className="text-sky">
            {label(session.settings, "job", "Jobs")}
          </Link>
        </p>
        <h1>Unassigned job activity</h1>
      </header>
      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Document</th>
              <th>Description</th>
              <th className="text-right">Amount</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-4 text-muted">
                  No unassigned job-costable lines found.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.lineId}>
                  <td>{row.sourceKind}</td>
                  <td>{row.documentNumber}</td>
                  <td>{row.description}</td>
                  <td className="text-right font-tabular">{money(row.amount)}</td>
                  <td>{row.issueDate}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
