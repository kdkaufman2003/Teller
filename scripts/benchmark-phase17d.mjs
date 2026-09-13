#!/usr/bin/env node
/**
 * Phase 17D local benchmark harness (static/synthetic — no production load).
 */
import { performance } from "node:perf_hooks";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const scenarios = [];

function bench(name, fn) {
  const start = performance.now();
  const result = fn();
  scenarios.push({ name, durationMs: Math.round(performance.now() - start), pass: Boolean(result) });
}

bench("batch_remaining_helper", () =>
  readFileSync(join(root, "src/lib/accounting/balances.ts"), "utf8").includes(
    "batchAuthoritativeDocumentRemaining",
  ),
);

bench("invoice_list_pagination", () =>
  readFileSync(join(root, "src/app/api/invoices/route.ts"), "utf8").includes(".range("),
);

bench("bill_list_pagination", () =>
  readFileSync(join(root, "src/app/api/bills/route.ts"), "utf8").includes(".range("),
);

bench("ledger_db_date_bounds", () => {
  const src = readFileSync(join(root, "src/app/api/ledger/route.ts"), "utf8");
  return src.includes("useDbPagination") && src.includes("addDaysISO");
});

bench("consolidated_bounded_parallel", () =>
  existsSync(join(root, "src/lib/accounting/consolidated/entity-parallel.ts")),
);

bench("job_profitability_scoped_lines", () => {
  const src = readFileSync(join(root, "src/lib/accounting/job-profitability.ts"), "utf8");
  return src.includes('.eq("job_id", jobId)') && !src.includes('from("teller_journal_entries").select("id")');
});

const failed = scenarios.filter((s) => !s.pass);
console.log(
  JSON.stringify(
    {
      PHASE17D_BENCHMARK: failed.length ? "FAIL" : "PASS",
      scenarios,
      note: "Static/synthetic checks — not production query timing.",
    },
    null,
    2,
  ),
);
process.exit(failed.length ? 1 : 0);
