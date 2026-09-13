import type { SupabaseClient } from "@supabase/supabase-js";

export type OpsStatusSnapshot = {
  hfacWebhook: {
    pending: number;
    failed: number;
    processed: number;
    stalePending: number;
  };
  scheduler: {
    enabled: boolean;
    recentFailures: number;
  };
  auditEvents: {
    total: number | null;
  };
};

export async function gatherOpsStatus(supabase: SupabaseClient): Promise<OpsStatusSnapshot> {
  const { data: hfacSnapshot, error: hfacError } = await supabase.rpc(
    "teller_hfac_webhook_ops_snapshot",
  );

  const { count: auditTotal } = await supabase
    .from("teller_audit_events")
    .select("id", { count: "exact", head: true });

  const { count: schedulerFailures } = await supabase
    .from("teller_scheduler_runs")
    .select("id", { count: "exact", head: true })
    .eq("status", "failed")
    .gte("started_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

  const schedulerEnabled = process.env.PRODUCTION_SCHEDULER_ENABLED === "true";

  const hfacRow =
    hfacError || !hfacSnapshot || typeof hfacSnapshot !== "object"
      ? null
      : (hfacSnapshot as Record<string, number>);

  return {
    hfacWebhook: {
      pending: hfacRow?.pending ?? 0,
      failed: hfacRow?.failed ?? 0,
      processed: hfacRow?.processed ?? 0,
      stalePending: hfacRow?.stale_pending ?? 0,
    },
    scheduler: {
      enabled: schedulerEnabled,
      recentFailures: schedulerFailures ?? 0,
    },
    auditEvents: {
      total: auditTotal,
    },
  };
}
