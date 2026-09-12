import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ConsolidatedReportsView } from "@/components/ConsolidatedReportsView";
import {
  buildConsolidatedBalanceSheet,
  buildConsolidatedCashFlow,
  buildConsolidatedProfitAndLoss,
  buildConsolidatedTrialBalance,
} from "@/lib/accounting/consolidated";
import { resolveActiveLegalEntityContext } from "@/lib/accounting/legal-entity";
import { parseFiscalYearStart } from "@/lib/org/config";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

type PageProps = {
  searchParams: Promise<{
    tab?: string;
    scope?: string;
    entityIds?: string;
    periodStart?: string;
    periodEnd?: string;
    asOf?: string;
  }>;
};

function parseTab(value: string | undefined) {
  if (
    value === "profit_loss" ||
    value === "balance_sheet" ||
    value === "cash_flow" ||
    value === "trial_balance"
  ) {
    return value;
  }
  return "trial_balance" as const;
}

export default async function ConsolidatedReportsPage({ searchParams }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const params = await searchParams;
  const tab = parseTab(params.tab);
  const today = new Date().toISOString().slice(0, 10);
  const periodEnd = params.periodEnd ?? params.asOf ?? today;
  const periodStart = params.periodStart ?? `${periodEnd.slice(0, 4)}-01-01`;
  const asOf = params.asOf ?? periodEnd;
  const includeAll = params.scope !== "selected";
  const selectedEntityIds = params.entityIds?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];

  const supabase = await createClient();
  const organizationId = session.organization.id;
  const auth = { userId: session.userId, role: session.profile?.role ?? "viewer" };

  const activeContext = await resolveActiveLegalEntityContext(supabase, {
    organizationId,
    auth,
    persistedLegalEntityId: session.profile?.active_legal_entity_id ?? null,
  });

  const accessibleEntities = activeContext.accessibleEntities.map((entity) => ({
    id: entity.id,
    name: entity.name,
    entityCode: entity.entityCode,
  }));

  if (accessibleEntities.length <= 1) {
    return (
      <div className="space-y-4">
        <header className="page-header">
          <h1>Consolidated reports</h1>
          <p>Add another company to use consolidated reporting.</p>
        </header>
        <Link href={routes.reports} className="text-sm text-sky hover:underline">
          Back to reports
        </Link>
      </div>
    );
  }

  const fiscalYearStart = parseFiscalYearStart(session.settings?.answers?.fiscalYearStart);
  const scopeInput = {
    organizationId,
    legalEntityIds: includeAll ? null : selectedEntityIds,
    includeAllEntities: includeAll,
    auth,
  };

  let error: string | null = null;
  let trialBalance = null;
  let profitAndLoss = null;
  let balanceSheet = null;
  let cashFlow = null;

  try {
    if (tab === "trial_balance") {
      trialBalance = await buildConsolidatedTrialBalance(supabase, {
        ...scopeInput,
        periodStart,
        periodEnd,
      });
    } else if (tab === "profit_loss") {
      profitAndLoss = await buildConsolidatedProfitAndLoss(supabase, {
        ...scopeInput,
        periodStart,
        periodEnd,
      });
    } else if (tab === "balance_sheet") {
      balanceSheet = await buildConsolidatedBalanceSheet(supabase, {
        ...scopeInput,
        asOf,
        fiscalYearStartMonth: fiscalYearStart,
      });
    } else {
      cashFlow = await buildConsolidatedCashFlow(supabase, {
        ...scopeInput,
        periodStart,
        periodEnd,
      });
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "Could not load consolidated report";
  }

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Consolidated reports</h1>
        <p>
          Pre-elimination financial statements across selected companies ·{" "}
          <Link href={routes.reports} className="text-sky hover:underline">
            Single-company reports
          </Link>
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-muted">Loading consolidated reports…</p>}>
        <ConsolidatedReportsView
          accessibleEntities={accessibleEntities}
          periodStart={periodStart}
          periodEnd={periodEnd}
          asOf={asOf}
          tab={tab}
          includeAll={includeAll}
          selectedEntityIds={selectedEntityIds}
          trialBalance={trialBalance}
          profitAndLoss={profitAndLoss}
          balanceSheet={balanceSheet}
          cashFlow={cashFlow}
          error={error}
        />
      </Suspense>
    </div>
  );
}
