import Link from "next/link";
import { redirect } from "next/navigation";
import { buildJobProfitabilitySummary } from "@/lib/accounting/job-profitability";
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

  const [{ data: party }, { data: invoices }, { data: budgets }] = await Promise.all([
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
      .from("teller_job_budget_lines")
      .select("id, cost_classification, estimated_amount, notes")
      .eq("organization_id", organizationId)
      .eq("job_id", id),
  ]);

  const profitability = await buildJobProfitabilitySummary(supabase, organizationId, id);
  const jobLabel = label(session.settings, "jobSingular", "Job");
  const contract =
    profitability.revisedContractAmount ?? profitability.originalContractAmount ?? job.quoted_amount;

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
          {party?.name ?? "No customer"} · Contract {money(contract)}
        </p>
      </header>

      <section className="grid gap-3 md:grid-cols-4 lg:grid-cols-6">
        {[
          { label: "Recognized revenue", value: money(profitability.recognizedRevenue) },
          { label: "Actual cost", value: money(profitability.actualDirectCost) },
          { label: "Committed", value: money(profitability.remainingCommittedCost) },
          { label: "Gross profit", value: money(profitability.grossProfit) },
          {
            label: "Margin",
            value:
              profitability.grossMarginPercent != null
                ? `${profitability.grossMarginPercent}%`
                : "—",
          },
          { label: "AR", value: money(profitability.accountsReceivable) },
          { label: "AP", value: money(profitability.accountsPayable) },
          { label: "Cash collected", value: money(profitability.cashCollected) },
          { label: "Deposits held", value: money(profitability.customerDepositsHeld) },
          { label: "Projected cost", value: money(profitability.projectedCost) },
          { label: "Projected GP", value: money(profitability.projectedGrossProfit) },
          { label: "Remaining budget", value: money(profitability.remainingBudget) },
        ].map((metric) => (
          <article key={metric.label} className="card p-4">
            <p className="text-xs uppercase tracking-wide text-muted">{metric.label}</p>
            <p className="font-ledger mt-1 text-xl font-tabular">{metric.value}</p>
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
              <dd className="capitalize">{(job.job_type as string).replace("_", " ")}</dd>
            </div>
            {job.address ? (
              <div>
                <dt className="text-muted">Address</dt>
                <dd>{job.address as string}</dd>
              </div>
            ) : null}
            {job.description ? (
              <div>
                <dt className="text-muted">Description</dt>
                <dd>{job.description as string}</dd>
              </div>
            ) : null}
          </dl>
        </article>

        <article className="card p-5">
          <h2 className="font-ledger text-xl text-navy">Budget vs actual</h2>
          <ul className="mt-3 divide-y divide-rule text-sm">
            {(budgets ?? []).length === 0 ? (
              <li className="py-3 text-muted">No budget lines yet.</li>
            ) : (
              (budgets ?? []).map((line) => (
                <li key={line.id as string} className="flex items-center justify-between py-3">
                  <span>
                    {line.cost_classification as string}
                    {line.notes ? ` · ${line.notes as string}` : ""}
                  </span>
                  <span className="font-tabular">{money(line.estimated_amount)}</span>
                </li>
              ))
            )}
          </ul>
        </article>
      </div>

      <article className="card p-5">
        <h2 className="font-ledger text-xl text-navy">Linked invoices</h2>
        <ul className="mt-3 divide-y divide-rule text-sm">
          {(invoices ?? []).length === 0 ? (
            <li className="py-3 text-muted">No header-linked invoices yet.</li>
          ) : (
            (invoices ?? []).map((invoice) => (
              <li key={invoice.id as string} className="flex items-center justify-between py-3">
                <Link href={invoicePath(invoice.id as string)} className="font-medium">
                  {invoice.number as string}
                </Link>
                <div className="text-right">
                  <p className="font-tabular">{money(invoice.total)}</p>
                  <StatusBadge status={invoice.status as string} />
                </div>
              </li>
            ))
          )}
        </ul>
      </article>

      <section className="card p-5">
        <h2 className="font-ledger text-xl text-navy">GL reconciliation</h2>
        <div className="mt-4 grid gap-6 md:grid-cols-2 text-sm">
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Revenue</h3>
            <dl className="mt-2 space-y-1 font-tabular">
              <div className="flex justify-between">
                <dt>GL activity</dt>
                <dd>{money(profitability.glReconciliation.revenue.glActivity)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Job-attributed</dt>
                <dd>{money(profitability.glReconciliation.revenue.jobAttributed)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Unassigned</dt>
                <dd>{money(profitability.glReconciliation.revenue.unassigned)}</dd>
              </div>
            </dl>
          </div>
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Direct cost</h3>
            <dl className="mt-2 space-y-1 font-tabular">
              <div className="flex justify-between">
                <dt>GL activity</dt>
                <dd>{money(profitability.glReconciliation.directCost.glActivity)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Job-attributed</dt>
                <dd>{money(profitability.glReconciliation.directCost.jobAttributed)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Unassigned</dt>
                <dd>{money(profitability.glReconciliation.directCost.unassigned)}</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>
    </div>
  );
}
