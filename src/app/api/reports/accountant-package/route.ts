import { NextResponse } from "next/server";
import { buildAccountantPackageFiles } from "@/lib/accounting/accountant-package";
import {
  buildReportContextFromParams,
  buildReportsFromEngine,
  loadReportEngineData,
} from "@/lib/accounting/report-engine";
import { buildTrialBalance } from "@/lib/accounting/trial-balance";
import { filterGlEntries, paginateGlReport } from "@/lib/accounting/gl-report";
import { enrichDocumentsWithAuthoritativePaid } from "@/lib/accounting/balances";
import { buildArAging, buildApAging } from "@/lib/accounting/aging-service";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { buildPlanningPackageExportFiles } from "@/lib/planning/accountant-package/export";
import { loadAccountantPlanningPackage } from "@/lib/planning/accountant-package/load-accountant-planning-package";
import { resolveLegalEntityId } from "@/lib/accounting/post";
import { jsonError, requireAccountingBooks } from "@/lib/api";
import { canExportBooks, parseCpaMode } from "@/lib/accounting/cpa";
import { parseFiscalYearStart, parseAccountingBasis } from "@/lib/org/config";
import { getSessionContext } from "@/lib/session";

export async function GET(request: Request) {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId, session: booksSession } = ctx;
  const entityId =
    legalEntityId ?? (await resolveLegalEntityId(supabase, organizationId, null));

  const session = await getSessionContext();
  const exportAllowed = canExportBooks(session?.profile?.role, parseCpaMode(session?.settings?.answers?.cpaMode));
  if (!exportAllowed) return jsonError("Export not permitted", 403);

  const url = new URL(request.url);
  const periodEnd = url.searchParams.get("periodEnd") ?? new Date().toISOString().slice(0, 10);
  const periodStart = url.searchParams.get("periodStart");
  const fiscalYearStart = parseFiscalYearStart(session?.settings?.answers?.fiscalYearStart);
  const basis = parseAccountingBasis(session?.settings?.answers?.basis);

  const reportCtx = buildReportContextFromParams({
    organizationId,
    startDate: periodStart,
    endDate: periodEnd,
    basis,
    fiscalYearStart,
    comparison: "none",
  });

  const data = await loadReportEngineData(supabase, organizationId, periodEnd, periodStart);
  const reports = await buildReportsFromEngine(supabase, reportCtx, data);
  const trialBalance = await buildTrialBalance(supabase, organizationId, {
    legalEntityId: entityId,
    periodStart,
    periodEnd,
  });

  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id, entry_date, memo, source_kind, source_id, reverses_entry_id")
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", entityId);
  const entryIds = (entries ?? []).map((e) => e.id as string);
  const { data: lines } = entryIds.length
    ? await supabase
        .from("teller_journal_lines")
        .select("id, entry_id, account_id, debit, credit, memo, job_id")
        .in("entry_id", entryIds)
    : { data: [] };

  const glEntries = paginateGlReport(
    filterGlEntries(
      (entries ?? []).map((row) => ({
        id: row.id as string,
        entry_date: row.entry_date as string,
        memo: row.memo as string | null,
        source_kind: row.source_kind as string | null,
        source_id: row.source_id as string | null,
        reverses_entry_id: row.reverses_entry_id as string | null,
      })),
      (lines ?? []).map((line) => ({
        id: line.id as string,
        entry_id: line.entry_id as string,
        account_id: line.account_id as string,
        debit: line.debit,
        credit: line.credit,
        memo: line.memo as string | null,
        job_id: line.job_id as string | null,
      })),
      data.accounts,
      { startDate: periodStart, endDate: periodEnd },
    ),
    1,
    100000,
  ).entries;

  const [{ data: invoices }, { data: bills }] = await Promise.all([
    supabase
      .from("teller_documents")
      .select("id, status, total, amount_paid, issue_date, due_date, party_id, posted_entry_id")
      .eq("organization_id", organizationId)
      .eq("kind", "invoice"),
    supabase
      .from("teller_documents")
      .select("id, kind, status, total, amount_paid, issue_date, due_date, party_id, posted_entry_id")
      .eq("organization_id", organizationId)
      .in("kind", ["bill", "expense"]),
  ]);

  const [invoicesPaid, billsPaid] = await Promise.all([
    enrichDocumentsWithAuthoritativePaid(supabase, organizationId, invoices ?? []),
    enrichDocumentsWithAuthoritativePaid(supabase, organizationId, bills ?? []),
  ]);

  const files = buildAccountantPackageFiles({
    organizationName: session?.organization?.name ?? "Organization",
    periodLabel: `${periodStart ?? "start"} – ${periodEnd}`,
    generatedAt: new Date().toISOString(),
    profitAndLoss: reports.profitAndLoss,
    balanceSheet: reports.balanceSheet,
    trialBalance,
    generalLedger: glEntries,
    arAging: buildArAging(invoicesPaid, data.partyNames, periodEnd),
    apAging: buildApAging(billsPaid, data.partyNames, periodEnd),
    includeTin: false,
  });

  const includePlanning = url.searchParams.get("includePlanning") === "1";
  if (includePlanning) {
    const planningPkg = await loadAccountantPlanningPackage(supabase, organizationId, {
      periodEnd,
      periodLabel: `${periodStart ?? "start"} – ${periodEnd}`,
      fiscalYear: Number(periodEnd.slice(0, 4)),
    });
    files.push(
      ...buildPlanningPackageExportFiles(
        planningPkg,
        session?.organization?.name ?? "organization",
      ),
    );
  }

  await recordAuditEvent(supabase, {
    organizationId,
    actorId: booksSession.userId,
    action: "data.exported",
    resourceKind: "accountant_package",
    resourceId: organizationId,
    metadata: { fileCount: files.length, periodEnd },
  });

  return NextResponse.json({ files: files.map((f) => ({ filename: f.filename, content: f.content })) });
}
