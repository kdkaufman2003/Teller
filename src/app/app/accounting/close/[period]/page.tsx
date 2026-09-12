import Link from "next/link";
import { canManagePeriodClose } from "@/lib/accounting/cpa";
import { resolveLegalEntityId } from "@/lib/accounting/post";
import { evaluateCloseReadiness } from "@/lib/accounting/close-readiness";
import {
  booksClosedThrough,
  endOfMonth,
  monthPeriod,
  type PeriodCloseRow,
} from "@/lib/accounting/periods";
import { money } from "@/lib/format";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { accountingClosePeriodPath, routes } from "@/lib/routes";
import { redirect, notFound } from "next/navigation";
import { ClosePeriodActions } from "@/components/ClosePeriodActions";
import { CloseChecklistPanel } from "@/components/CloseChecklistPanel";
import { ClosePlanningContextPanel } from "@/components/planning/ClosePlanningContextPanel";

type PageProps = { params: Promise<{ period: string }> };

function parsePeriodKey(key: string): { year: number; month: number } | null {
  const match = key.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

export default async function ClosePeriodDetailPage({ params }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const { period: periodKey } = await params;
  const parsed = parsePeriodKey(periodKey);
  if (!parsed) notFound();

  const period = monthPeriod(parsed.year, parsed.month);
  const periodEnd = endOfMonth(parsed.year, parsed.month);
  const supabase = await createClient();
  const organizationId = session.organization.id;
  const legalEntityId = await resolveLegalEntityId(
    supabase,
    organizationId,
    session.profile?.active_legal_entity_id ?? null,
  );
  const role = session.profile?.role ?? "viewer";
  const canManageClose = canManagePeriodClose(role);

  const [{ data: closes }, readiness] = await Promise.all([
    supabase
      .from("teller_period_closes")
      .select("id, period_end, notes, closed_at, closed_by, effective_closed_through")
      .eq("organization_id", organizationId)
      .eq("legal_entity_id", legalEntityId)
      .order("closed_at", { ascending: false })
      .limit(24),
    evaluateCloseReadiness(supabase, organizationId, legalEntityId, periodEnd),
  ]);

  const closeRows = (closes ?? []) as PeriodCloseRow[];
  const closedThrough = booksClosedThrough(closeRows);
  const isClosed = closedThrough ? period.end <= closedThrough.slice(0, 10) : false;

  return (
    <div className="space-y-6">
      <header className="page-header">
        <Link href={routes.accountingClose} className="text-sm text-muted">
          ← Month-end close
        </Link>
        <h1 className="mt-2">{period.label}</h1>
        <p className="text-muted">
          Period ends {periodEnd} ·{" "}
          <span className="capitalize">{isClosed ? "closed" : "open"}</span>
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="card p-4">
          <p className="text-sm text-muted">Status</p>
          <p className="font-ledger mt-1 text-xl capitalize text-navy">
            {readiness.status.replace(/_/g, " ")}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-sm text-muted">Blockers</p>
          <p className="font-ledger mt-1 text-xl text-navy">{readiness.blockerCount}</p>
        </div>
        <div className="card p-4">
          <p className="text-sm text-muted">Warnings</p>
          <p className="font-ledger mt-1 text-xl text-navy">{readiness.warningCount}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href={`${routes.accountingTrialBalance}?periodEnd=${periodEnd}&periodStart=${period.start}`}
          className="btn"
        >
          Trial balance
        </Link>
        <Link href={routes.accountingAdjustments} className="btn">
          Adjustments
        </Link>
      </div>

      {canManageClose && !isClosed ? (
        <ClosePeriodActions periodEnd={periodEnd} readiness={readiness} />
      ) : null}

      <CloseChecklistPanel
        periodEnd={periodEnd}
        items={(readiness.checklist ?? []) as import("@/components/CloseChecklistPanel").CloseChecklistItem[]}
        canManage={canManageClose}
      />

      <ClosePlanningContextPanel
        supabase={supabase}
        organizationId={organizationId}
        periodEnd={periodEnd}
        periodLabel={period.label}
        fiscalYear={parsed.year}
      />

      <div className="card overflow-hidden">
        <div className="border-b px-4 py-3 font-medium">Findings</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Title</th>
              <th>Description</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {readiness.findings.map((finding) => (
              <tr key={finding.key}>
                <td className="capitalize">{finding.severity}</td>
                <td>{finding.title}</td>
                <td className="text-muted">{finding.description}</td>
                <td className="text-right">
                  {finding.route ? (
                    <Link href={finding.route} className="text-sm text-sky hover:underline">
                      Review
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
            {!readiness.findings.length ? (
              <tr>
                <td colSpan={4} className="text-muted py-6 text-center">
                  No findings — period looks ready.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {readiness.reconciliations.length ? (
        <div className="card overflow-hidden">
          <div className="border-b px-4 py-3 font-medium">Reconciliations</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="text-right">Difference</th>
                <th>Blocker</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {readiness.reconciliations.map((item) => (
                <tr key={item.key}>
                  <td>{item.name}</td>
                  <td className="text-right font-tabular">{money(item.difference)}</td>
                  <td>{item.blocker ? "Yes" : "No"}</td>
                  <td className="text-right">
                    {item.route ? (
                      <Link href={item.route} className="text-sm text-sky hover:underline">
                        Open
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
