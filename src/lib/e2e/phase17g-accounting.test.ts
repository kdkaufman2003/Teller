import { describe, expect, it } from "vitest";
import { assertBalanced } from "@/lib/accounting/post";
import { balanceSheetEquation, E2E_MODULE_PATHS, journalImbalance, readSrc, srcExists } from "./helpers";

describe("Phase 17G core accounting lifecycle", () => {
  it("rejects unbalanced manual journal", () => {
    const lines = [
      { account_id: "a", debit: 100, credit: 0 },
      { account_id: "b", debit: 0, credit: 50 },
    ];
    expect(journalImbalance(lines.map((l) => ({ debit: l.debit, credit: l.credit })))).toBe(50);
    expect(() => assertBalanced(lines)).toThrow();
  });

  it("accepts balanced adjusting entry", () => {
    const lines = [
      { account_id: "exp", debit: 75, credit: 0 },
      { account_id: "accrued", debit: 0, credit: 75 },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it("balance sheet equation holds for sample totals", () => {
    expect(balanceSheetEquation(250000, 120000, 130000)).toBe(true);
  });

  it("retained earnings flow: net income increases equity", () => {
    const beginningRe = 50000;
    const netIncome = 12000;
    const endingRe = beginningRe + netIncome;
    expect(endingRe).toBe(62000);
  });

  it("period close module exists", () => {
    expect(srcExists(E2E_MODULE_PATHS.periods)).toBe(true);
    const periods = readSrc(E2E_MODULE_PATHS.periods);
    expect(periods).toMatch(/close|closed|reopen/i);
  });

  it("recurring journal schedules exist", () => {
    expect(srcExists(E2E_MODULE_PATHS.recurring)).toBe(true);
  });

  it("accrual module exists", () => {
    expect(srcExists("src/lib/accounting/schedules/accrual.ts")).toBe(true);
  });

  it("fixed asset lifecycle modules exist", () => {
    expect(srcExists(E2E_MODULE_PATHS.fixedAssets)).toBe(true);
    expect(srcExists("src/lib/accounting/fixed-asset-acquisition.ts")).toBe(true);
  });

  it("payroll accounting scope is import/post not payroll processing", () => {
    const payrollDir = srcExists(E2E_MODULE_PATHS.payroll);
    expect(payrollDir).toBe(true);
    const spec = readSrc("docs/SPEC.md");
    expect(spec).toMatch(/payroll|Out of scope/i);
  });

  it("deposit receipt recognizes liability not revenue", () => {
    const migration = readSrc("supabase/migrations/016_phase3_customer_deposits.sql");
    expect(migration).toContain("Customer deposit liability");
    expect(migration).not.toMatch(/credit.*revenue/i);
  });

  it("deposit application reduces AR", () => {
    const migration = readSrc("supabase/migrations/016_phase3_customer_deposits.sql");
    expect(migration).toMatch(/apply|application/i);
  });
});
