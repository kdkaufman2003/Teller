import { NextResponse } from "next/server";
import { filterGlEntries, paginateGlReport } from "@/lib/accounting/gl-report";
import { jsonError, requireBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "50");
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  const accountId = url.searchParams.get("accountId");
  const sourceKind = url.searchParams.get("sourceKind");
  const search = url.searchParams.get("search");
  const jobId = url.searchParams.get("jobId");

  const { data: entries, error: entriesError } = await supabase
    .from("teller_journal_entries")
    .select("id, entry_date, memo, source_kind, source_id, reverses_entry_id")
    .eq("organization_id", organizationId)
    .order("entry_date", { ascending: false });

  if (entriesError) return jsonError(entriesError.message, 500);

  const entryIds = (entries ?? []).map((row) => row.id as string);
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
      .eq("organization_id", organizationId),
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
    { startDate, endDate, accountId, sourceKind, search, jobId },
  );

  const result = paginateGlReport(filtered, page, pageSize);

  return NextResponse.json({
    ...result,
    accounts: accounts ?? [],
  });
}
