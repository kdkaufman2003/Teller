import { NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { canExportBooks, parseCpaMode } from "@/lib/accounting/cpa";
import {
  buildJournalCsv,
  buildPartiesCsv,
  buildTrialBalanceCsv,
  exportFilename,
  summarizeTrialBalance,
  type ExportJournalEntry,
} from "@/lib/accounting/exports";
import { jsonError, requireBooks } from "@/lib/api";

const EXPORT_KINDS = new Set(["journal", "trial_balance", "parties"]);

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const { searchParams } = new URL(request.url);
  const kind = searchParams.get("kind") ?? "journal";
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  if (!EXPORT_KINDS.has(kind)) {
    return jsonError("Unsupported export kind", 400);
  }

  const { data: settings } = await supabase
    .from("teller_industry_settings")
    .select("answers")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const answers =
    settings?.answers && typeof settings.answers === "object"
      ? (settings.answers as Record<string, unknown>)
      : {};
  const cpaMode = parseCpaMode(answers.cpaMode);

  if (!canExportBooks(session.profile?.role, cpaMode)) {
    return jsonError("You do not have permission to export books", 403);
  }

  const asOf = (end ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  let csv = "";
  let rowCount = 0;

  if (kind === "parties") {
    const { data, error } = await supabase
      .from("teller_parties")
      .select("name, kind, email, phone")
      .eq("organization_id", organizationId)
      .order("name");

    if (error) return jsonError(error.message, 500);

    const rows = (data ?? []).map((row) => ({
      name: row.name,
      kind: row.kind,
      email: row.email ?? "",
      phone: row.phone ?? "",
    }));
    rowCount = rows.length;
    csv = buildPartiesCsv(rows);
  } else {
    let entriesQuery = supabase
      .from("teller_journal_entries")
      .select("id, entry_date, memo, source_kind")
      .eq("organization_id", organizationId)
      .order("entry_date", { ascending: true });

    if (start) entriesQuery = entriesQuery.gte("entry_date", start);
    if (end) entriesQuery = entriesQuery.lte("entry_date", end);

    const [{ data: entries }, { data: accounts }] = await Promise.all([
      entriesQuery,
      supabase
        .from("teller_accounts")
        .select("id, code, name, type")
        .eq("organization_id", organizationId)
        .order("code"),
    ]);

    const entryIds = (entries ?? []).map((row) => row.id);
    const { data: lines, error: lineError } = entryIds.length
      ? await supabase
          .from("teller_journal_lines")
          .select("entry_id, account_id, debit, credit, memo")
          .in("entry_id", entryIds)
      : { data: [], error: null };

    if (lineError) return jsonError(lineError.message, 500);

    if (kind === "trial_balance") {
      const rows = summarizeTrialBalance(lines ?? [], accounts ?? []);
      rowCount = rows.length;
      csv = buildTrialBalanceCsv(rows);
    } else {
      const accountMap = new Map((accounts ?? []).map((row) => [row.id, row]));
      const journalRows: ExportJournalEntry[] = [];

      for (const entry of entries ?? []) {
        const entryLines = (lines ?? []).filter((line) => line.entry_id === entry.id);
        for (const line of entryLines) {
          const account = accountMap.get(line.account_id);
          journalRows.push({
            entry_date: entry.entry_date,
            memo: entry.memo ?? "",
            source_kind: entry.source_kind,
            account_code: account?.code ?? "",
            account_name: account?.name ?? "",
            debit: line.debit,
            credit: line.credit,
            line_memo: line.memo ?? "",
          });
        }
      }

      rowCount = journalRows.length;
      csv = buildJournalCsv(journalRows);
    }
  }

  await recordAuditEvent(supabase, {
    organizationId,
    actorId: session.userId,
    action: "data.exported",
    resourceKind: "export",
    metadata: { kind, start, end, rowCount, cpaMode },
  });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(kind, asOf)}"`,
    },
  });
}
