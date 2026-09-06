import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";

export type ApSettings = {
  requireBillApproval: boolean;
  billApprovalThreshold: number | null;
  requirePoApproval: boolean;
  poApprovalThreshold: number | null;
  defaultCostCategories: string[];
};

export async function loadApSettings(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ApSettings> {
  const { data } = await supabase
    .from("teller_ap_settings")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();

  return {
    requireBillApproval: Boolean(data?.require_bill_approval),
    billApprovalThreshold:
      data?.bill_approval_threshold == null ? null : asNumber(data.bill_approval_threshold),
    requirePoApproval: Boolean(data?.require_po_approval),
    poApprovalThreshold:
      data?.po_approval_threshold == null ? null : asNumber(data.po_approval_threshold),
    defaultCostCategories: Array.isArray(data?.default_cost_categories)
      ? (data.default_cost_categories as string[])
      : [],
  };
}

export function billRequiresApproval(settings: ApSettings, total: number): boolean {
  if (!settings.requireBillApproval) return false;
  if (settings.billApprovalThreshold == null) return true;
  return total > settings.billApprovalThreshold + 0.009;
}

export function poRequiresApproval(settings: ApSettings, total: number): boolean {
  if (!settings.requirePoApproval) return false;
  if (settings.poApprovalThreshold == null) return true;
  return total > settings.poApprovalThreshold + 0.009;
}
