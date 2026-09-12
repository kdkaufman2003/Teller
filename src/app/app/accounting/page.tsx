import Link from "next/link";
import { AccountingView } from "@/components/AccountingView";
import { CompanyContextHeader } from "@/components/legal-entity/CompanyContextHeader";
import {
  canExportBooks,
  canManagePeriodClose,
  canPostAdjustments,
  parseCpaMode,
} from "@/lib/accounting/cpa";
import { resolveLegalEntityId } from "@/lib/accounting/post";
import {
  booksClosedThrough,
  nextCloseablePeriodEnd,
  recentMonthPeriods,
  type PeriodCloseRow,
} from "@/lib/accounting/periods";
import { listAccessibleLegalEntities } from "@/lib/accounting/legal-entity/active-context";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

export default async function AccountingPage() {
  const session = await getSessionContext();
  if (!session?.organization || !session.profile) redirect(routes.setup);

  const supabase = await createClient();
  const organizationId = session.organization.id;
  const legalEntityId = await resolveLegalEntityId(
    supabase,
    organizationId,
    session.profile.active_legal_entity_id ?? null,
  );
  const role = session.profile.role ?? "viewer";
  const answers = session.settings?.answers ?? {};
  const cpaMode = parseCpaMode(answers.cpaMode);

  const [{ data: closes }, entities] = await Promise.all([
    supabase
      .from("teller_period_closes")
      .select("id, period_end, notes, closed_at, closed_by, legal_entity_id")
      .eq("organization_id", organizationId)
      .eq("legal_entity_id", legalEntityId)
      .order("period_end", { ascending: false })
      .limit(24),
    listAccessibleLegalEntities(supabase, organizationId, {
      userId: session.profile.id,
      role: session.profile.role,
    }),
  ]);

  const closeRows = (closes ?? []) as PeriodCloseRow[];
  const closedThrough = booksClosedThrough(closeRows);
  const multiEntity = entities.filter((entity) => entity.isActive).length > 1;

  let multiEntityCloseSummary: Array<{
    name: string;
    entityCode: string;
    closedThrough: string | null;
  }> = [];
  if (multiEntity) {
    const { data: allCloses } = await supabase
      .from("teller_period_closes")
      .select("legal_entity_id, period_end, closed_at, event_type, effective_closed_through")
      .eq("organization_id", organizationId)
      .order("closed_at", { ascending: false });
    type CloseSlice = Pick<
      PeriodCloseRow,
      "period_end" | "effective_closed_through" | "closed_at" | "event_type"
    >;
    const byEntity = new Map<string, CloseSlice[]>();
    for (const row of allCloses ?? []) {
      const entityId = row.legal_entity_id as string;
      const bucket = byEntity.get(entityId) ?? [];
      bucket.push({
        period_end: row.period_end as string,
        closed_at: row.closed_at as string,
        event_type: row.event_type as CloseSlice["event_type"],
        effective_closed_through: row.effective_closed_through as string | null,
      });
      byEntity.set(entityId, bucket);
    }
    multiEntityCloseSummary = entities
      .filter((entity) => entity.isActive)
      .map((entity) => ({
        name: entity.name,
        entityCode: entity.entityCode,
        closedThrough: booksClosedThrough(byEntity.get(entity.id) ?? []),
      }));
  }

  return (
    <div className="space-y-6">
      <CompanyContextHeader
        activeLegalEntity={session.activeLegalEntity}
        subtitle="Period close and adjustments for the active company"
        showAllCompaniesLink={multiEntity}
      />
      <header className="page-header">
        <h1>Accounting</h1>
        <p>Period close, CPA exports, and manual adjustments</p>
        <Link href={routes.accountingWorkspace} className="mt-2 inline-block text-sm text-sky">
          Open accountant workspace →
        </Link>
      </header>
      {multiEntity ? (
        <section className="card overflow-hidden">
          <div className="border-b border-rule px-4 py-3">
            <h2 className="font-ledger text-lg text-navy">Close status by company</h2>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Books closed through</th>
              </tr>
            </thead>
            <tbody>
              {multiEntityCloseSummary.map((row) => (
                <tr key={row.entityCode}>
                  <td>
                    {row.name}
                    <span className="ml-2 text-xs text-muted">{row.entityCode}</span>
                  </td>
                  <td>{row.closedThrough ?? "Open"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      <AccountingView
        closedThrough={closedThrough}
        nextClose={nextCloseablePeriodEnd(closedThrough)}
        periods={recentMonthPeriods(12, new Date(), closedThrough)}
        closes={closeRows}
        canManageClose={canManagePeriodClose(role)}
        canAdjust={canPostAdjustments(role)}
        canExport={canExportBooks(role, cpaMode)}
        cpaMode={cpaMode}
        role={role}
      />
    </div>
  );
}
