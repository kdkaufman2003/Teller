import Link from "next/link";
import { CompanyContextHeader } from "@/components/legal-entity/CompanyContextHeader";
import { evaluateCloseReadiness } from "@/lib/accounting/close-readiness";
import { reconcileSubledgersToGl } from "@/lib/accounting/subledger";
import { buildTrialBalance } from "@/lib/accounting/trial-balance";
import { resolveLegalEntityId } from "@/lib/accounting/post";
import { booksClosedThrough, nextCloseablePeriodEnd, type PeriodCloseRow } from "@/lib/accounting/periods";
import { closeReadinessUserMessage, companyBooksLabel } from "@/lib/legal-entity/ux";
import { money } from "@/lib/format";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import {
  accountingClosePeriodPath,
  routes,
} from "@/lib/routes";
import { redirect } from "next/navigation";

export default async function AccountantWorkspacePage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const supabase = await createClient();
  const organizationId = session.organization.id;
  const legalEntityId = await resolveLegalEntityId(
    supabase,
    organizationId,
    session.profile?.active_legal_entity_id ?? null,
  );
  const companyName = session.activeLegalEntity?.name ?? "Current company";
  const asOf = new Date().toISOString().slice(0, 10);
  const periodStart = `${asOf.slice(0, 4)}-01-01`;

  const [{ data: closes }, tb, subledgers] = await Promise.all([
    supabase
      .from("teller_period_closes")
      .select("period_end, closed_at, event_type, effective_closed_through")
      .eq("organization_id", organizationId)
      .eq("legal_entity_id", legalEntityId)
      .order("closed_at", { ascending: false })
      .limit(24),
    buildTrialBalance(supabase, organizationId, {
      legalEntityId,
      periodStart,
      periodEnd: asOf,
    }),
    reconcileSubledgersToGl(supabase, organizationId, legalEntityId),
  ]);

  const closedThrough = booksClosedThrough((closes ?? []) as PeriodCloseRow[]);
  const nextClose = nextCloseablePeriodEnd(closedThrough);
  const readiness = nextClose
    ? await evaluateCloseReadiness(supabase, organizationId, legalEntityId, nextClose)
    : null;
  const ar = subledgers.find((row) => row.side === "ar");
  const ap = subledgers.find((row) => row.side === "ap");
  const blockers = readiness?.findings.filter((f) => f.severity === "blocker") ?? [];

  return (
    <div className="space-y-6">
      <CompanyContextHeader
        activeLegalEntity={session.activeLegalEntity}
        subtitle="Accountant workspace for the active company"
        showAllCompaniesLink
      />
      <header className="page-header">
        <h1>Accountant workspace</h1>
        <p className="text-muted">
          {companyBooksLabel(companyName, session.activeLegalEntity?.entityCode)} · Books closed
          through {closedThrough ?? "not closed"}
        </p>
      </header>

      <section className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <article className="card p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Trial balance</p>
          <p className="mt-2 font-ledger text-2xl text-navy">
            {tb.balanced ? "Balanced" : "Out of balance"}
          </p>
          <Link href={routes.accountingTrialBalance} className="mt-2 inline-block text-sm text-sky">
            Open trial balance →
          </Link>
        </article>
        <article className="card p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Accounts receivable</p>
          <p className="mt-2 font-tabular text-lg">
            {ar?.consistent ? "Reconciled" : "Needs review"}
          </p>
          {ar && !ar.consistent ? (
            <p className="text-xs text-muted">Difference {money(ar.difference)}</p>
          ) : null}
        </article>
        <article className="card p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Accounts payable</p>
          <p className="mt-2 font-tabular text-lg">
            {ap?.consistent ? "Reconciled" : "Needs review"}
          </p>
          {ap && !ap.consistent ? (
            <p className="text-xs text-muted">Difference {money(ap.difference)}</p>
          ) : null}
        </article>
        <article className="card p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Close readiness</p>
          <p className="mt-2 font-ledger text-2xl text-navy">
            {readiness?.ready ? "Ready" : `${blockers.length} blocker(s)`}
          </p>
          {readiness?.periodEnd ? (
            <Link
              href={accountingClosePeriodPath(readiness.periodEnd)}
              className="mt-2 inline-block text-sm text-sky"
            >
              Review close →
            </Link>
          ) : null}
        </article>
      </section>

      {blockers.length ? (
        <section className="card p-5">
          <h2 className="font-ledger text-xl text-navy">Open accounting issues</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {blockers.map((finding) => (
              <li key={finding.key}>
                {closeReadinessUserMessage(finding)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card p-5">
        <h2 className="font-ledger text-xl text-navy">Quick actions</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={routes.ledger} className="btn btn-secondary text-sm">
            General ledger
          </Link>
          <Link href={routes.banking} className="btn btn-secondary text-sm">
            Banking
          </Link>
          <Link href={routes.accountingIntegrity} className="btn btn-secondary text-sm">
            Integrity checks
          </Link>
          <Link href={routes.accountingClose} className="btn btn-secondary text-sm">
            Month-end close
          </Link>
          <Link href={routes.reports} className="btn btn-secondary text-sm">
            Company reports
          </Link>
          <Link href={routes.reportsConsolidated} className="btn btn-ghost text-sm">
            Consolidated reports
          </Link>
        </div>
      </section>
    </div>
  );
}
