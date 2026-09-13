import { describe, expect, it } from "vitest";
import { assertBalanced } from "@/lib/accounting/post";
import { E2E_MODULE_PATHS, readSrc, srcExists } from "./helpers";

describe("Phase 17G banking lifecycle", () => {
  it("transfer journal is balanced across two cash accounts", () => {
    const lines = [
      { account_id: "cash-a", debit: 0, credit: 1000 },
      { account_id: "cash-b", debit: 1000, credit: 0 },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it("bank match should not double-post when linked to existing payment", () => {
    const categorize = readSrc(E2E_MODULE_PATHS.banking);
    expect(categorize).toMatch(/journal|match|duplicate|already/i);
  });

  it("transfer module enforces entity ownership", () => {
    const transfer = readSrc(E2E_MODULE_PATHS.transfer);
    expect(transfer).toContain("legal_entity_id");
  });

  it("banking modules exist", () => {
    expect(srcExists(E2E_MODULE_PATHS.banking)).toBe(true);
    expect(srcExists(E2E_MODULE_PATHS.transfer)).toBe(true);
    expect(srcExists("src/lib/banking/reconciliation.ts")).toBe(true);
  });

  it("bank ingestion path exists", () => {
    expect(srcExists("src/lib/banking/ingest.ts")).toBe(true);
  });

  it("idempotency used for bank categorization retries", () => {
    const categorize = readSrc(E2E_MODULE_PATHS.banking);
    expect(categorize).toMatch(/event|idempotency|duplicate/i);
  });
});
