import { NextResponse } from "next/server";
import { filterGlEntries, paginateGlReport } from "@/lib/accounting/gl-report";
import { resolveLegalEntityId } from "@/lib/accounting/post";
import { jsonError, requireAccountingBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId } = ctx;
  const entityId =
    legalEntityId ?? (await resolveLegalEntityId(supabase, organizationId, null));

  const url = new URL(request.url);
  const legacy = url.searchParams.get("legacy") === "1";
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("pageSize") ?? legacy ? "50" : "50");

  const { data: entries, error } = await supabase
    .from("teller_journal_entries")
    .select("id, entry_date, memo, source_kind, source_id, reverses_entry_id")
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", entityId)
    .order("entry_date", { ascending: false });

  if (error) return jsonError(error.message, 500);

  const entryIds = (entries ?? []).map((row) => row.id);
  const [{ data: lines }, { data: accounts }] = await Promise.all([
    entryIds.length
      ? supabase
          .from("teller_journal_lines")
          .select("id, entry_id, account_id, debit, credit, memo, job_id")
          .in("entry_id", entryIds)
      : Promise.resolve({ data: [] }),
    supabase
      .from("teller_accounts")
      .select("id, code, name, type")
      .eq("organization_id", organizationId)
      .eq("legal_entity_id", entityId),
  ]);

  const filtered = filterGlEntries(
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
    accounts ?? [],
    {},
  );

  const result = paginateGlReport(filtered, page, pageSize);

  if (legacy) {
    const accountMap = new Map(
      (accounts ?? []).map((row) => [row.id, `${row.code} ${row.name}`]),
    );
    return NextResponse.json({
      entries: result.entries.map((entry) => ({
        id: entry.id,
        entry_date: entry.entryDate,
        memo: entry.memo,
        source_kind: entry.sourceKind,
        source_id: entry.sourceId,
        lines: entry.lines.map((line) => ({
          ...line,
          account_name: accountMap.get(line.accountId) || "Account",
        })),
      })),
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        totalCount: result.totalCount,
        hasMore: result.hasMore,
      },
    });
  }

  return NextResponse.json(result);
}
