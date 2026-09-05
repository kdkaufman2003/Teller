import Link from "next/link";
import { redirect } from "next/navigation";
import { buildJobProfitability } from "@/lib/accounting/job-reports";
import { StatusBadge } from "@/components/StatusBadge";
import { invoicePath, routes } from "@/lib/routes";
import { money } from "@/lib/format";
import { getSessionContext, hasModule, label } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

type PageProps = { params: Promise<{ id: string }> };

export default async function JobDetailPage({ params }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  if (!hasModule(session.settings, "jobs")) redirect(routes.app);

  const { id } = await params;
  const supabase = await createClient();
  const organizationId = session.organization.id;

  const { data: job } = await supabase
    .from("teller_jobs")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();

  if (!job) redirect(routes.jobs);

  const [{ data: party }, { data: invoices }, { data: accounts }] = await Promise.all([
    job.party_id
      ? supabase.from("teller_parties").select("name").eq("id", job.party_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("teller_documents")
      .select("id, number, status, total, issue_date")
      .eq("organization_id", organizationId)
      .eq("kind", "invoice")
      .eq("job_id", id)
      .order("issue_date", { ascending: false }),
    supabase
      .from("teller_accounts")
      .select("id, code, name, type")
      .eq("organization_id", organizationId),
  ]);

  const { data: journalLines } = await supabase
    .from("teller_journal_lines")
    .select("account_id, debit, credit, job_id")
    .eq("job_id", id);

  const profitability = buildJobProfitability(id, journalLines ?? [], accounts ?? []);
  const jobLabel = label(session.settings, "jobSingular", "Job");

  return (
    <div className="space-y-6">
      <header className="page-header">
        <p className="text-sm text-muted">
          <Link href={routes.jobs} className="text-sky">
            {label(session.settings, "job", "Jobs")}
          </Link>
        </p>
        <h1>
          {job.job_number} · {job.name}
        </h1>
        <p className="text-sm text-muted">
          {party?.name ?? "No customer"} · Quoted {money(job.quoted_amount)}
        </p>
      </header>

      <section className="grid gap-3 md:grid-cols-4">
        {[
          { label: "Revenue", value: money(profitability.revenue) },
          { label: "Direct costs", value: money(profitability.cogs) },
          { label: "Gross profit", value: money(profitability.grossProfit) },
          { label: `${jobLabel} profit`, value: money(profitability.netJobProfit) },
        ].map((metric) => (
          <article key={metric.label} className="card p-4">
            <p className="text-xs uppercase tracking-wide text-muted">{metric.label}</p>
            <p className="font-ledger mt-1 text-2xl font-tabular">{metric.value}</p>
          </article>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <article className="card p-5">
          <h2 className="font-ledger text-xl text-navy">{jobLabel} details</h2>
          <dl className="mt-3 grid gap-2 text-sm">
            <div>
              <dt className="text-muted">Status</dt>
              <dd>
                <StatusBadge status={job.status} />
              </dd>
            </div>
            <div>
              <dt className="text-muted">Type</dt>
              <dd className="capitalize">{job.job_type.replace("_", " ")}</dd>
            </div>
            {job.address ? (
              <div>
                <dt className="text-muted">Address</dt>
                <dd>{job.address}</dd>
              </div>
            ) : null}
          </dl>
        </article>

        <article className="card p-5">
          <h2 className="font-ledger text-xl text-navy">Linked invoices</h2>
          <ul className="mt-3 divide-y divide-rule text-sm">
            {(invoices ?? []).length === 0 ? (
              <li className="py-3 text-muted">No invoices linked to this {jobLabel.toLowerCase()} yet.</li>
            ) : (
              (invoices ?? []).map((invoice) => (
                <li key={invoice.id} className="flex items-center justify-between py-3">
                  <Link href={invoicePath(invoice.id)} className="font-medium">
                    {invoice.number}
                  </Link>
                  <div className="text-right">
                    <p className="font-tabular">{money(invoice.total)}</p>
                    <StatusBadge status={invoice.status} />
                  </div>
                </li>
              ))
            )}
          </ul>
        </article>
      </div>

      {(profitability.revenueLines.length > 0 || profitability.cogsLines.length > 0) ? (
        <section className="card p-5">
          <h2 className="font-ledger text-xl text-navy">Posted activity</h2>
          <div className="mt-4 grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Revenue</h3>
              <ul className="mt-2 space-y-1 text-sm font-tabular">
                {profitability.revenueLines.map((line) => (
                  <li key={line.code} className="flex justify-between">
                    <span>
                      {line.code} · {line.name}
                    </span>
                    <span>{money(line.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Direct costs</h3>
              <ul className="mt-2 space-y-1 text-sm font-tabular">
                {profitability.cogsLines.length === 0 ? (
                  <li className="text-muted">No direct costs posted yet.</li>
                ) : (
                  profitability.cogsLines.map((line) => (
                    <li key={line.code} className="flex justify-between">
                      <span>
                        {line.code} · {line.name}
                      </span>
                      <span>{money(line.amount)}</span>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
