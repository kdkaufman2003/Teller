import type { SupabaseClient } from "@supabase/supabase-js";
import { loadTaxSettings } from "../load-tax-settings";
import type { TaxGlReconciliationReport } from "./types";
import type { TaxReportReadiness } from "./types";

export async function buildTaxReportReadiness(
  supabase: SupabaseClient,
  organizationId: string,
  glReport: TaxGlReconciliationReport,
  needsReviewCount: number,
): Promise<TaxReportReadiness> {
  const { settings } = await loadTaxSettings(supabase, organizationId);
  const { data: registrations } = await supabase
    .from("teller_tax_registrations")
    .select("status")
    .eq("organization_id", organizationId);
  const activeRegistrationCount = (registrations ?? []).filter((r) => r.status === "active").length;
  const blockingReasons: string[] = [];

  if (!settings.salesTaxPayableAccountId) {
    blockingReasons.push("Sales tax payable account is not configured");
  }
  if (activeRegistrationCount === 0) {
    blockingReasons.push("No active tax registrations");
  }
  if (needsReviewCount > 0) {
    blockingReasons.push(`${needsReviewCount} tax transaction(s) need review`);
  }
  for (const exception of glReport.exceptions) {
    if (exception.severity === "blocking") blockingReasons.push(exception.message);
  }

  let status: TaxReportReadiness["status"] = "ready";
  if (!settings.salesTaxPayableAccountId || activeRegistrationCount === 0) {
    status = "incomplete_configuration";
  } else if (Math.abs(glReport.difference) > 0.009) {
    status = "unreconciled";
  } else if (needsReviewCount > 0 || glReport.exceptions.some((e) => e.severity === "blocking")) {
    status = "needs_review";
  }

  return {
    status,
    blockingReasons,
    exceptionCount: glReport.exceptionCount + needsReviewCount,
  };
}
