import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileSubledgersToGl } from "./subledger";
import { reconcileDepositsToGl } from "./deposit-reconciliation";
import { buildFixedAssetReconciliationReport } from "./fixed-asset-reconciliation";
import { buildOrgJobGlReconciliation } from "./org-job-reconciliation";
import { getLastCompletedReconciliation } from "@/lib/banking/reconciliation";

export type CloseReconciliationItem = {
  key: string;
  name: string;
  status: "ok" | "warning" | "error" | "skipped";
  difference: number;
  blocker: boolean;
  route?: string;
  details?: unknown;
};

export async function buildCloseReconciliationSummary(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    asOfDate: string;
    periodYear?: number;
    periodMonth?: number;
    legalEntityId?: string | null;
  },
): Promise<CloseReconciliationItem[]> {
  const asOfDate = input.asOfDate.slice(0, 10);
  const periodYear = input.periodYear ?? new Date(asOfDate + "T12:00:00").getFullYear();
  const periodMonth = input.periodMonth ?? new Date(asOfDate + "T12:00:00").getMonth() + 1;
  const legalEntityId = input.legalEntityId?.trim() ?? null;
  const items: CloseReconciliationItem[] = [];

  const arAp = await reconcileSubledgersToGl(supabase, organizationId, legalEntityId);
  for (const side of arAp) {
    items.push({
      key: side.side,
      name: side.side === "ar" ? "Accounts Receivable" : "Accounts Payable",
      status: side.consistent ? "ok" : "error",
      difference: side.difference,
      blocker: !side.consistent,
      route: "/app/accounting/integrity",
      details: side,
    });
  }

  const deposits = await reconcileDepositsToGl(supabase, organizationId);
  if (deposits) {
    items.push({
      key: "deposits",
      name: "Customer Deposits",
      status: deposits.consistent ? "ok" : "error",
      difference: deposits.difference,
      blocker: !deposits.consistent,
      route: "/app/accounting/integrity",
      details: deposits,
    });
  }

  const fa = await buildFixedAssetReconciliationReport(supabase, organizationId, {
    asOfDate,
    periodYear,
    periodMonth,
  });
  for (const [key, label] of [
    ["fa_cost", "Fixed Asset Cost"],
    ["fa_accum", "Accumulated Depreciation"],
    ["fa_expense", "Depreciation Expense"],
  ] as const) {
    const slice =
      key === "fa_cost"
        ? fa.fixedAssetCost
        : key === "fa_accum"
          ? fa.accumulatedDepreciation
          : fa.depreciationExpense;
    items.push({
      key,
      name: label,
      status: Math.abs(slice.difference) <= 0.01 ? "ok" : "error",
      difference: slice.difference,
      blocker: Math.abs(slice.difference) > 0.01,
      route: "/app/assets/reconciliation",
      details: slice,
    });
  }

  const jobs = await buildOrgJobGlReconciliation(supabase, organizationId, asOfDate);
  for (const [key, label, slice] of [
    ["job_revenue", "Job Revenue GL Bridge", jobs.revenue],
    ["job_direct_cost", "Job Direct Cost GL Bridge", jobs.directCost],
  ] as const) {
    items.push({
      key,
      name: label,
      status: Math.abs(slice.difference) <= 0.01 ? "ok" : "error",
      difference: slice.difference,
      blocker: Math.abs(slice.difference) > 0.01,
      route: "/app/jobs/unassigned",
      details: slice,
    });
  }

  let bankAccountQuery = supabase
    .from("teller_bank_accounts")
    .select("id, name")
    .eq("organization_id", organizationId)
    .eq("is_active", true);
  if (legalEntityId) {
    bankAccountQuery = bankAccountQuery.eq("legal_entity_id", legalEntityId);
  }
  const { data: bankAccounts } = await bankAccountQuery;

  const { data: closeSettings } = await supabase
    .from("teller_close_settings")
    .select("required_bank_account_ids")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const requiredBankIds = new Set(
    ((closeSettings?.required_bank_account_ids ?? []) as string[]).filter(Boolean),
  );

  for (const account of bankAccounts ?? []) {
    const accountId = account.id as string;
    const isRequired = requiredBankIds.size > 0 && requiredBankIds.has(accountId);
    const last = await getLastCompletedReconciliation(supabase, organizationId, accountId);
    const ok = Boolean(last && last.statementEndDate >= asOfDate);
    items.push({
      key: `bank_${accountId}`,
      name: `Bank: ${account.name as string}`,
      status: ok ? "ok" : isRequired ? "error" : "warning",
      difference: 0,
      blocker: isRequired && !ok,
      route: "/app/banking/reconcile",
      details: { lastReconciliation: last, required: isRequired },
    });
  }

  return items;
}
