import type { SupabaseClient } from "@supabase/supabase-js";
import { buildTrialBalance } from "@/lib/accounting/trial-balance";
import { booksClosedThrough, type PeriodCloseRow } from "@/lib/accounting/periods";
import {
  computeApOpenSubledgerTotal,
  computeArOpenSubledgerTotal,
} from "@/lib/accounting/subledger";
import type { LegalEntitySummary } from "@/lib/accounting/legal-entity/types";

export type CompanyOverviewRow = {
  legalEntityId: string;
  name: string;
  entityCode: string;
  isDefault: boolean;
  isActive: boolean;
  cash: number;
  receivables: number;
  payables: number;
  revenue: number;
  netIncome: number;
  booksClosedThrough: string | null;
};

export async function loadCompaniesOverview(
  supabase: SupabaseClient,
  organizationId: string,
  entities: LegalEntitySummary[],
  asOf: string,
): Promise<CompanyOverviewRow[]> {
  const periodEnd = asOf.slice(0, 10);
  const periodStart = `${periodEnd.slice(0, 4)}-01-01`;

  const rows: CompanyOverviewRow[] = [];

  for (const entity of entities) {
    if (!entity.isActive) continue;

    const [tb, ar, ap, { data: closes }, { data: accountMeta }] = await Promise.all([
      buildTrialBalance(supabase, organizationId, {
        legalEntityId: entity.id,
        periodStart,
        periodEnd,
      }),
      computeArOpenSubledgerTotal(supabase, organizationId, entity.id),
      computeApOpenSubledgerTotal(supabase, organizationId, entity.id),
      supabase
        .from("teller_period_closes")
        .select("period_end, closed_at, event_type, effective_closed_through")
        .eq("organization_id", organizationId)
        .eq("legal_entity_id", entity.id)
        .order("closed_at", { ascending: false })
        .limit(24),
      supabase
        .from("teller_accounts")
        .select("id, subtype, type")
        .eq("organization_id", organizationId)
        .eq("legal_entity_id", entity.id),
    ]);

    const subtypeByAccountId = new Map(
      (accountMeta ?? []).map((row) => [row.id as string, row.subtype as string | null]),
    );

    let cash = 0;
    let revenue = 0;
    let expenses = 0;
    for (const row of tb.rows) {
      const subtype = subtypeByAccountId.get(row.accountId);
      const net =
        row.type === "asset" || row.type === "expense" || row.type === "cogs"
          ? row.adjustedDebit - row.adjustedCredit
          : row.adjustedCredit - row.adjustedDebit;
      if (subtype === "bank" || subtype === "cash" || row.code === "1000") {
        cash += net;
      }
      if (row.type === "revenue") revenue += net;
      if (row.type === "expense") expenses += Math.abs(net);
    }

    rows.push({
      legalEntityId: entity.id,
      name: entity.name,
      entityCode: entity.entityCode,
      isDefault: entity.isDefault,
      isActive: entity.isActive,
      cash,
      receivables: ar.total,
      payables: ap.total,
      revenue,
      netIncome: revenue - expenses,
      booksClosedThrough: booksClosedThrough((closes ?? []) as PeriodCloseRow[]),
    });
  }

  return rows;
}
