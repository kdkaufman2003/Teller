import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseListPagination, MAX_LIST_PAGE_SIZE } from "./pagination";
import { mapWithBoundedConcurrency } from "./bounded-parallel";
import { CONSOLIDATED_ENTITY_CONCURRENCY } from "../accounting/consolidated/entity-parallel";

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("Phase 17D performance (static + semantics)", () => {
  it("pagination caps page size", () => {
    expect(parseListPagination(new URLSearchParams("pageSize=10000")).pageSize).toBe(MAX_LIST_PAGE_SIZE);
  });

  it("pagination computes offset", () => {
    expect(parseListPagination(new URLSearchParams("page=3&pageSize=25")).offset).toBe(50);
  });

  it("bounded parallel preserves result order", async () => {
    const out = await mapWithBoundedConcurrency([1, 2, 3], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30]);
  });

  it("consolidated entity concurrency is bounded", () => {
    expect(CONSOLIDATED_ENTITY_CONCURRENCY).toBeGreaterThan(0);
    expect(CONSOLIDATED_ENTITY_CONCURRENCY).toBeLessThanOrEqual(8);
  });

  it("batch remaining balance helper exists", () => {
    expect(read("src/lib/accounting/balances.ts")).toContain("batchAuthoritativeDocumentRemaining");
  });

  it("patch 053 prepared with probe", () => {
    const sql = read("supabase/patches/053_phase17d_performance_hardening.sql");
    expect(sql).toContain("teller_phase17d_performance_probe");
    expect(sql.toLowerCase()).not.toMatch(/disable row level security/);
  });

  it("invoice and bill APIs paginate", () => {
    expect(read("src/app/api/invoices/route.ts")).toMatch(/\.range\(/);
    expect(read("src/app/api/bills/route.ts")).toMatch(/\.range\(/);
  });

  it("ledger API uses date-bounded DB pagination path", () => {
    expect(read("src/app/api/ledger/route.ts")).toContain("useDbPagination");
  });

  it("performance doc exists", () => {
    expect(existsSync(join(ROOT, "docs/PHASE-17D-PERFORMANCE.md"))).toBe(true);
  });
});
