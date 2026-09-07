/**
 * Local Phase 10 report performance benchmark (synthetic in-memory data).
 */
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildBalanceSheet } from "../src/lib/accounting/financial-reports";
import {
  buildComparativeProfitAndLoss,
  buildProfitAndLossForPeriod,
} from "../src/lib/accounting/comparative-reports";
import { filterGlEntries, paginateGlReport } from "../src/lib/accounting/gl-report";
import { resolveJournalSource } from "../src/lib/accounting/source-resolver";
import { asNumber } from "../src/lib/format";
import type { AccountRow } from "../src/lib/accounting/reports";

const ACCOUNTS: AccountRow[] = [
  { id: "cash", code: "1000", name: "Cash", type: "asset", subtype: "bank" },
  { id: "ar", code: "1100", name: "AR", type: "asset", subtype: "receivable" },
  { id: "ap", code: "2000", name: "AP", type: "liability", subtype: "payable" },
  { id: "rev", code: "4000", name: "Revenue", type: "revenue" },
  { id: "exp", code: "6100", name: "Expense", type: "expense" },
  { id: "equity", code: "3000", name: "Equity", type: "equity" },
];

function syntheticLines(lineCount: number) {
  const entries: Array<{
    id: string;
    entry_date: string;
    memo: string | null;
    source_kind: string | null;
    source_id: string | null;
    reverses_entry_id: string | null;
  }> = [];
  const lines: Array<{
    id: string;
    entry_id: string;
    account_id: string;
    debit: number;
    credit: number;
    memo: string | null;
    job_id: string | null;
  }> = [];

  for (let i = 0; i < lineCount; i += 2) {
    const entryId = `e${i}`;
    const day = String((i % 28) + 1).padStart(2, "0");
    const entryDate = `2026-03-${day}`;
    entries.push({
      id: entryId,
      entry_date: entryDate,
      memo: `Synthetic ${i}`,
      source_kind: i % 5 === 0 ? "invoice" : "manual",
      source_id: i % 5 === 0 ? `doc-${i}` : null,
      reverses_entry_id: null,
    });
    lines.push({
      id: `l${i}`,
      entry_id: entryId,
      account_id: i % 4 === 0 ? "rev" : "exp",
      debit: i % 4 === 0 ? 0 : 10,
      credit: i % 4 === 0 ? 10 : 0,
      memo: null,
      job_id: null,
    });
    lines.push({
      id: `l${i + 1}`,
      entry_id: entryId,
      account_id: "cash",
      debit: i % 4 === 0 ? 10 : 0,
      credit: i % 4 === 0 ? 0 : 10,
      memo: null,
      job_id: null,
    });
  }

  const datedLines = lines.map((line) => {
    const entry = entries.find((e) => e.id === line.entry_id);
    return {
      account_id: line.account_id,
      debit: line.debit,
      credit: line.credit,
      entry_date: entry?.entry_date ?? "2026-03-01",
    };
  });

  return { entries, lines, datedLines };
}

function bench<T>(name: string, fn: () => T): { name: string; ms: number; result: T } {
  const start = performance.now();
  const result = fn();
  return { name, ms: Math.round((performance.now() - start) * 100) / 100, result };
}

function runSuite(lineCount: number) {
  const { entries, lines, datedLines } = syntheticLines(lineCount);

  const pl = bench("profit_and_loss", () =>
    buildProfitAndLossForPeriod({
      basis: "accrual",
      lines: datedLines,
      accounts: ACCOUNTS,
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    }),
  );

  const priorPl = buildProfitAndLossForPeriod({
    basis: "accrual",
    lines: datedLines.filter((l) => l.entry_date < "2026-03-15"),
    accounts: ACCOUNTS,
    startDate: "2026-02-01",
    endDate: "2026-02-28",
  });

  const comparative = bench("comparative_pl", () =>
    buildComparativeProfitAndLoss(pl.result, priorPl),
  );
  const bs = bench("balance_sheet", () =>
    buildBalanceSheet(datedLines, ACCOUNTS, "2026-03-31", 1),
  );
  const tb = bench("trial_balance", () => {
    let debit = 0;
    let credit = 0;
    for (const line of datedLines) {
      debit += asNumber(line.debit);
      credit += asNumber(line.credit);
    }
    return { balanced: Math.abs(debit - credit) < 0.01, debit, credit };
  });
  const glFiltered = bench("gl_page", () => {
    const filtered = filterGlEntries(entries, lines, ACCOUNTS, { accountId: "cash" });
    const mapped = filtered.map((entry) => ({
      id: entry.id,
      entryDate: entry.entry_date,
      memo: entry.memo,
      sourceKind: entry.source_kind,
      sourceId: entry.source_id,
      reversesEntryId: entry.reverses_entry_id,
      lines: entry.lines,
      source: resolveJournalSource({
        sourceKind: entry.source_kind,
        sourceId: entry.source_id,
        memo: entry.memo,
        reversesEntryId: entry.reverses_entry_id,
      }),
    }));
    return paginateGlReport(mapped, 1, 50);
  });

  return {
    lineCount,
    journalEntries: entries.length,
    journalLines: lines.length,
    timingsMs: {
      profit_and_loss: pl.ms,
      balance_sheet: bs.ms,
      trial_balance: tb.ms,
      comparative_pl: comparative.ms,
      gl_page: glFiltered.ms,
    },
    sanity: {
      netIncome: pl.result.netIncome,
      totalAssets: bs.result.totalAssets,
      tbBalanced: tb.result.balanced,
      glPageSize: glFiltered.result.entries.length,
    },
  };
}

const results = {
  generatedAt: new Date().toISOString(),
  unboundedReportFetches: [],
  suites: [runSuite(10_000), runSuite(100_000)],
};

const outDir = resolve(process.cwd(), "tmp");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, "phase10-benchmark.json");
writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
