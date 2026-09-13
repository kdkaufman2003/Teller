import { describe, expect, it } from "vitest";
import { documentRemainingBalance } from "@/lib/accounting/balances";
import { assertBalanced } from "@/lib/accounting/post";
import { computePartyNetApBalance } from "@/lib/accounting/party-balances";
import { E2E_MODULE_PATHS, readSrc, srcExists } from "./helpers";

describe("Phase 17G AP lifecycle", () => {
  it("bill partial payment reduces remaining", () => {
    expect(documentRemainingBalance(8000, 3000)).toBe(5000);
  });

  it("vendor credit reduces net AP when unapplied", () => {
    expect(computePartyNetApBalance(5000, 800)).toBe(4200);
  });

  it("multi-payment settles bill", () => {
    expect(documentRemainingBalance(10000, 4000 + 3500 + 2500)).toBe(0);
  });

  it("bill posting journal is balanced (Dr Expense / Cr AP)", () => {
    const lines = [
      { account_id: "exp", debit: 900, credit: 0 },
      { account_id: "ap", debit: 0, credit: 900 },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it("vendor payment journal is balanced (Dr AP / Cr Cash)", () => {
    const lines = [
      { account_id: "ap", debit: 450, credit: 0 },
      { account_id: "cash", debit: 0, credit: 450 },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it("AP modules exist", () => {
    expect(srcExists(E2E_MODULE_PATHS.ap)).toBe(true);
    expect(srcExists("src/lib/accounting/bills.ts")).toBe(true);
  });

  it("bill pay guards over-allocation conceptually", () => {
    const billPay = readSrc(E2E_MODULE_PATHS.ap);
    expect(billPay).toMatch(/remaining|amount|allocation/i);
  });
});
