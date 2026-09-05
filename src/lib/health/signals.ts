import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysISO, todayISO } from "@/lib/format";
import type { HealthSignals } from "./types";

const HFAC_STALE_DAYS = 7;

export async function gatherHealthSignals(
  supabase: SupabaseClient,
  organizationId: string,
  options: { hfacEnabled: boolean },
): Promise<HealthSignals> {
  const today = todayISO();
  const overdueCutoff = addDaysISO(-30, today);

  const [
    invoices,
    expenses,
    bankConnections,
    bankTransactions,
    taxPending,
    journalEntries,
    hfacIntegration,
  ] = await Promise.all([
    supabase
      .from("teller_documents")
      .select("id, status, due_date, issue_date")
      .eq("organization_id", organizationId)
      .eq("kind", "invoice"),
    supabase
      .from("teller_documents")
      .select("id, status, attachment_path, metadata")
      .eq("organization_id", organizationId)
      .eq("kind", "expense"),
    supabase
      .from("teller_bank_connections")
      .select("id, status")
      .eq("organization_id", organizationId),
    supabase
      .from("teller_bank_transactions")
      .select("match_status")
      .eq("organization_id", organizationId),
    supabase
      .from("teller_tax_determinations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("review_status", "pending_review"),
    supabase
      .from("teller_journal_entries")
      .select("entry_date")
      .eq("organization_id", organizationId)
      .order("entry_date", { ascending: false })
      .limit(1),
    options.hfacEnabled
      ? supabase
          .from("teller_integrations")
          .select("last_synced_at")
          .eq("organization_id", organizationId)
          .in("provider", ["hfac", "quoter"])
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const invoiceRows = invoices.data ?? [];
  const expenseRows = expenses.data ?? [];

  const draftInvoiceCount = invoiceRows.filter((row) => row.status === "draft").length;
  const openInvoiceCount = invoiceRows.filter((row) => row.status === "open").length;
  const overdueInvoiceCount = invoiceRows.filter((row) => {
    if (row.status !== "open") return false;
    const due = row.due_date || row.issue_date;
    return Boolean(due && due < overdueCutoff);
  }).length;

  const draftExpenseCount = expenseRows.filter((row) => row.status === "draft").length;
  const receiptExpenseWithoutAttachment = expenseRows.filter((row) => {
    const meta =
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};
    return meta.expense_type === "receipt" && !row.attachment_path;
  }).length;

  const bankRows = bankConnections.data ?? [];
  const bankConnectionCount = bankRows.length;
  const bankConnectionErrorCount = bankRows.filter((row) => row.status === "error").length;

  const txnRows = bankTransactions.data ?? [];
  const unmatchedBankCount = txnRows.filter((row) => row.match_status === "unmatched").length;
  const suggestedBankCount = txnRows.filter((row) => row.match_status === "suggested").length;

  let hfacStaleSync = false;
  let hfacLastSyncedAt: string | null = null;
  if (options.hfacEnabled && hfacIntegration.data) {
    hfacLastSyncedAt = hfacIntegration.data.last_synced_at ?? null;
    if (!hfacLastSyncedAt) {
      hfacStaleSync = true;
    } else {
      const staleAfter = addDaysISO(-HFAC_STALE_DAYS, today);
      hfacStaleSync = hfacLastSyncedAt.slice(0, 10) < staleAfter;
    }
  }

  return {
    draftInvoiceCount,
    overdueInvoiceCount,
    openInvoiceCount,
    draftExpenseCount,
    receiptExpenseWithoutAttachment,
    unmatchedBankCount,
    suggestedBankCount,
    bankConnectionCount,
    bankConnectionErrorCount,
    hfacEnabled: options.hfacEnabled,
    hfacStaleSync,
    hfacLastSyncedAt,
    taxPendingReviewCount: taxPending.count ?? 0,
    lastPostedDate: journalEntries.data?.[0]?.entry_date ?? null,
  };
}
