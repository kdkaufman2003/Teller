import { NextResponse } from "next/server";
import { asNumber } from "@/lib/format";
import { jsonError, requireBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const [invoices, expenses, jobs, parties, integration] = await Promise.all([
    supabase
      .from("teller_documents")
      .select("id, number, status, total, amount_paid, issue_date, kind, party_id")
      .eq("organization_id", organizationId)
      .eq("kind", "invoice")
      .order("issue_date", { ascending: false })
      .limit(20),
    supabase
      .from("teller_documents")
      .select("id, number, status, total, kind")
      .eq("organization_id", organizationId)
      .eq("kind", "expense"),
    supabase
      .from("teller_jobs")
      .select("id, job_number, name, status, quoted_amount")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(8),
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
  ]);

  if (invoices.error) return jsonError(invoices.error.message, 500);

  const invoiceRows = invoices.data ?? [];
  const expenseRows = expenses.data ?? [];
  const openAR = invoiceRows
    .filter((row) => row.status === "open")
    .reduce((sum, row) => sum + asNumber(row.total) - asNumber(row.amount_paid), 0);
  const paid = invoiceRows
    .filter((row) => row.status === "paid")
    .reduce((sum, row) => sum + asNumber(row.total), 0);
  const openAP = expenseRows
    .filter((row) => row.status === "open")
    .reduce((sum, row) => sum + asNumber(row.total), 0);

  const partyNames = new Map((parties.data ?? []).map((row) => [row.id, row.name]));

  return NextResponse.json({
    organization: session.organization,
    settings: session.settings,
    metrics: {
      openAR,
      cashCollected: paid,
      openAP,
      invoiceCount: invoiceRows.length,
      customerCount: (parties.data ?? []).length,
      activeJobs: (jobs.data ?? []).filter((job) =>
        ["estimate", "scheduled", "in_progress"].includes(job.status),
      ).length,
    },
    recentInvoices: invoiceRows.slice(0, 6).map((row) => ({
      ...row,
      party_name: row.party_id ? partyNames.get(row.party_id) || "" : "",
    })),
    jobs: jobs.data ?? [],
    hfac: integration.data ?? null,
  });
}
