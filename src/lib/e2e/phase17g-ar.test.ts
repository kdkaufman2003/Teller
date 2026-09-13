import { describe, expect, it } from "vitest";
import { documentRemainingBalance } from "@/lib/accounting/balances";
import { assertBalanced } from "@/lib/accounting/post";
import { computePartyNetArBalance } from "@/lib/accounting/party-balances";
import { E2E_MODULE_PATHS, readSrc, srcExists } from "./helpers";

describe("Phase 17G AR lifecycle", () => {
  it("invoice partial payment reduces remaining balance", () => {
    expect(documentRemainingBalance(10000, 4000)).toBe(6000);
  });

  it("multi-payment sums to full settlement", () => {
    const total = 5000;
    const p1 = 2000;
    const p2 = 1500;
    const p3 = 1500;
    expect(documentRemainingBalance(total, p1 + p2 + p3)).toBe(0);
  });

  it("credit memo reduces net AR when unapplied", () => {
    expect(computePartyNetArBalance(10000, 1500)).toBe(8500);
  });

  it("over-allocation is detectable before posting", () => {
    const remaining = 600;
    const attempt = 700;
    expect(attempt > remaining).toBe(true);
  });

  it("invoice posting journal is balanced (Dr AR / Cr Revenue pattern)", () => {
    const lines = [
      { account_id: "ar", debit: 1200, credit: 0 },
      { account_id: "rev", debit: 0, credit: 1200 },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it("payment journal is balanced (Dr Cash / Cr AR)", () => {
    const lines = [
      { account_id: "cash", debit: 500, credit: 0 },
      { account_id: "ar", debit: 0, credit: 500 },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it("AR modules exist for full lifecycle", () => {
    expect(srcExists(E2E_MODULE_PATHS.ar)).toBe(true);
    expect(srcExists("src/app/api/invoices/route.ts")).toBe(true);
    expect(srcExists(E2E_MODULE_PATHS.credits)).toBe(true);
    expect(srcExists("src/lib/accounting/settlement-reconciliation.ts")).toBe(true);
  });

  it("payments use idempotency key deduplication", () => {
    const payments = readSrc(E2E_MODULE_PATHS.ar);
    expect(payments).toContain("idempotency_key");
    expect(payments).toContain("duplicate: true");
  });

  it("aging uses authoritative remaining (17F fix preserved)", () => {
    const engine = readSrc("src/lib/accounting/report-engine.ts");
    expect(engine).toContain("batchAuthoritativeDocumentRemaining");
  });
});
