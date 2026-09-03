import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { money } from "@/lib/format";
import { label } from "@/lib/session";
import { routes } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext, hasHfacIntegration, hasModule } from "@/lib/session";
import { asNumber } from "@/lib/format";
import { redirect } from "next/navigation";

export default async function DashboardPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();
  const organizationId = session.organization.id;

  const [invoices, expenses, jobs, parties, integration] = await Promise.all([
    supabase
      .from("teller_documents")
      .select("id, number, status, total, amount_paid, issue_date, party_id")
      .eq("organization_id", organizationId)
      .eq("kind", "invoice")
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("teller_documents")
      .select("status, total")
      .eq("organization_id", organizationId)
      .eq("kind", "expense"),
    supabase
      .from("teller_jobs")
      .select("id, job_number, name, status, quoted_amount")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(6),
    supabase
      .from("teller_parties")
      .select("id, name")
      .eq("organization_id", organizationId),
    supabase
      .from("teller_integrations")
      .select("enabled, last_synced_at, last_sync_summary")
      .eq("organization_id", organizationId)
      .eq("provider", "hfac")
      .maybeSingle(),
  ]);

  const invoiceRows = invoices.data ?? [];
  const partyNames = new Map((parties.data ?? []).map((row) => [row.id, row.name]));
  const openAR = invoiceRows
    .filter((row) => row.status === "open")
    .reduce((sum, row) => sum + asNumber(row.total) - asNumber(row.amount_paid), 0);
  const collected = invoiceRows
    .filter((row) => row.status === "paid")
    .reduce((sum, row) => sum + asNumber(row.total), 0);
  const openAP = (expenses.data ?? [])
    .filter((row) => row.status === "open")
    .reduce((sum, row) => sum + asNumber(row.total), 0);

  const customerLabel = label(session.settings, "customer", "Customers");
  const showJobs = hasModule(session.settings, "jobs");
  const showIntegrations = hasHfacIntegration(session.settings);

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm text-muted">Books for</p>
        <h1 className="font-ledger text-4xl text-navy">{session.organization.name}</h1>
      </header>

      <section className="grid gap-3 md:grid-cols-3">
        {[
          { label: "Open receivables", value: money(openAR) },
          { label: "Collected", value: money(collected) },
          { label: "Open payables", value: money(openAP) },
        ].map((metric) => (
          <article key={metric.label} className="card p-5">
            <p className="text-xs uppercase tracking-[0.14em] text-muted">{metric.label}</p>
            <p className="font-ledger mt-2 text-3xl font-tabular text-navy">{metric.value}</p>
          </article>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <article className="card p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="font-ledger text-2xl text-navy">Recent invoices</h2>
            <Link href={routes.invoiceNew} className="btn btn-primary text-sm">
              New invoice
            </Link>
          </div>
          <ul className="mt-4 divide-y divide-rule">
            {invoiceRows.length === 0 ? (
              <li className="py-6 text-sm text-muted">
                No invoices yet. Create one manually or import won quotes from
                Settings → Integrations.
              </li>
            ) : (
              invoiceRows.map((row) => (
                <li key={row.id} className="flex items-center justify-between py-3">
                  <div>
                    <Link href={`${routes.invoices}/${row.id}`} className="font-medium">
                      {row.number}
                    </Link>
                    <p className="text-sm text-muted">
                      {row.party_id ? partyNames.get(row.party_id) : "No customer"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-tabular">{money(row.total)}</p>
                    <StatusBadge status={row.status} />
                  </div>
                </li>
              ))
            )}
          </ul>
        </article>

        <div className="space-y-4">
          {showJobs ? (
            <article className="card p-5">
              <div className="flex items-center justify-between">
                <h2 className="font-ledger text-xl text-navy">
                  {label(session.settings, "job", "Jobs")}
                </h2>
                <Link href={routes.jobs} className="text-sm text-sky">
                  View
                </Link>
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                {(jobs.data ?? []).length === 0 ? (
                  <li className="text-muted">No jobs yet.</li>
                ) : (
                  (jobs.data ?? []).map((job) => (
                    <li key={job.id} className="flex justify-between gap-3">
                      <span>
                        {job.job_number} · {job.name}
                      </span>
                      <StatusBadge status={job.status} />
                    </li>
                  ))
                )}
              </ul>
            </article>
          ) : null}

          {showIntegrations ? (
            <article className="card p-5">
              <h2 className="font-ledger text-xl text-navy">Hassle Free AC</h2>
              <p className="mt-2 text-sm text-muted">
                Won deals from Hassle Free AC import as draft invoices for{" "}
                {customerLabel.toLowerCase()}.
              </p>
              <p className="mt-3 text-xs text-muted">
                {integration.data?.last_synced_at
                  ? `Last sync ${new Date(integration.data.last_synced_at).toLocaleString()}`
                  : "Not synced yet"}
              </p>
              <Link href={routes.settings} className="btn btn-ghost mt-3 text-sm">
                Manage integrations
              </Link>
            </article>
          ) : null}
        </div>
      </section>
    </div>
  );
}
