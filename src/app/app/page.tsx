import Link from "next/link";
import { HealthPanel } from "@/components/HealthPanel";
import { IntelligencePanel } from "@/components/IntelligencePanel";
import { computeHealthReport } from "@/lib/health/engine";
import { gatherHealthSignals } from "@/lib/health/signals";
import { buildIntelligenceReport } from "@/lib/intelligence/engine";
import { gatherIntelligenceContext, isAiEnabled } from "@/lib/intelligence/signals";
import type { IntelligenceSuggestion } from "@/lib/intelligence/types";
import { canWriteBooks } from "@/lib/auth/roles";
import { parseFiscalYearStart } from "@/lib/org/config";
import { StatusBadge } from "@/components/StatusBadge";
import { money } from "@/lib/format";
import { isBilledInvoice } from "@/lib/accounting/reports";
import {
  computeApOpenSubledgerTotal,
  computeArOpenSubledgerTotal,
} from "@/lib/accounting/subledger";
import { dashboardMetricsForIndustry } from "@/lib/dashboard/metrics";
import { label } from "@/lib/session";
import { routes, jobPath } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext, hasHfacIntegration, hasModule } from "@/lib/session";
import { asNumber } from "@/lib/format";
import { redirect } from "next/navigation";

export default async function DashboardPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();
  const organizationId = session.organization.id;

  const [invoices, expenses, jobs, parties, integration, arSubledger, apSubledger] =
    await Promise.all([
    supabase
      .from("teller_documents")
      .select("id, number, status, total, amount_paid, issue_date, party_id, posted_entry_id")
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
    computeArOpenSubledgerTotal(supabase, organizationId),
    computeApOpenSubledgerTotal(supabase, organizationId),
  ]);

  const invoiceRows = invoices.data ?? [];
  const partyNames = new Map((parties.data ?? []).map((row) => [row.id, row.name]));
  const openAR = arSubledger.total;
  const collected = invoiceRows
    .filter((row) => row.status === "paid" && isBilledInvoice(row))
    .reduce((sum, row) => sum + asNumber(row.total), 0);
  const openAP = apSubledger.total;
  const activeJobs = (jobs.data ?? []).filter((job) =>
    ["estimate", "scheduled", "in_progress"].includes(job.status),
  ).length;

  const metricDefs = dashboardMetricsForIndustry(session.organization.industry_id, session.settings);
  const metricValues: Record<string, string> = {
    openAR: money(openAR),
    collected: money(collected),
    openAP: money(openAP),
    activeJobs: String(activeJobs),
  };

  const customerLabel = label(session.settings, "customer", "Customers");
  const showJobs = hasModule(session.settings, "jobs");
  const showIntegrations = hasHfacIntegration(session.settings);

  const healthSignals = await gatherHealthSignals(supabase, organizationId, {
    hfacEnabled: showIntegrations,
  });
  const healthReport = computeHealthReport(healthSignals);

  const answers = session.settings?.answers ?? {};
  const intelligenceContext = await gatherIntelligenceContext(supabase, {
    organizationId,
    answers,
    fiscalYearStart: parseFiscalYearStart(answers.fiscalYearStart),
  });
  const { data: suggestionRows } = await supabase
    .from("teller_intelligence_suggestions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(20);
  const intelligenceReport = buildIntelligenceReport({
    context: intelligenceContext,
    persistedSuggestions: (suggestionRows ?? []).map(
      (row): IntelligenceSuggestion => ({
        id: row.id,
        kind: row.kind,
        fingerprint: row.fingerprint,
        title: row.title,
        description: row.description,
        confidence: row.confidence ?? undefined,
        href: row.href ?? undefined,
        payload:
          row.payload && typeof row.payload === "object"
            ? (row.payload as Record<string, unknown>)
            : undefined,
        resourceKind: row.resource_kind ?? undefined,
        resourceId: row.resource_id ?? undefined,
      }),
    ),
    aiEnabled: isAiEnabled(),
  });

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted">Books for</p>
          <h1 className="font-ledger text-4xl text-navy">{session.organization.name}</h1>
        </div>
        <Link href={routes.reports} className="btn btn-secondary text-sm">
          View reports
        </Link>
      </header>

      <HealthPanel report={healthReport} />

      <IntelligencePanel
        report={intelligenceReport}
        canManage={canWriteBooks(session.profile?.role)}
      />

      <section className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        {metricDefs.map((metric) => (
          <article key={metric.key} className="card p-5">
            <p className="text-xs uppercase tracking-[0.14em] text-muted">{metric.label}</p>
            <p className="font-ledger mt-2 text-3xl font-tabular text-navy">
              {metricValues[metric.key] ?? "—"}
            </p>
            {metric.hint ? <p className="mt-1 text-xs text-muted">{metric.hint}</p> : null}
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
                      <Link href={jobPath(job.id)} className="hover:text-sky">
                        {job.job_number} · {job.name}
                      </Link>
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
