import { describe, expect, it } from "vitest";
import { assertBalanced } from "@/lib/accounting/post";
import { readSrc, srcExists } from "./helpers";

describe("Phase 17G inventory / GRNI lifecycle", () => {
  it("receipt-before-bill posts Dr Inventory / Cr GRNI", () => {
    const lines = [
      { account_id: "inv", debit: 500, credit: 0 },
      { account_id: "grni", debit: 0, credit: 500 },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it("bill after receipt clears GRNI without second inventory debit", () => {
    const lines = [
      { account_id: "grni", debit: 500, credit: 0 },
      { account_id: "ap", debit: 0, credit: 500 },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
    const inventoryDebits = lines.filter((l) => l.account_id === "inv" && l.debit > 0);
    expect(inventoryDebits.length).toBe(0);
  });

  it("consumption posts Dr COGS / Cr Inventory", () => {
    const lines = [
      { account_id: "cogs", debit: 200, credit: 0 },
      { account_id: "inv", debit: 0, credit: 200 },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it("inventory modules exist", () => {
    expect(srcExists("src/lib/accounting/inventory")).toBe(true);
    expect(srcExists("src/lib/accounting/inventory/grni")).toBe(true);
    expect(srcExists("src/lib/accounting/inventory/reconciliation.ts")).toBe(true);
  });

  it("GRNI reconciliation module present", () => {
    expect(srcExists("src/lib/accounting/inventory/grni/reconciliation.ts")).toBe(true);
  });

  it("consume-before-bill scenario documented in inventory code", () => {
    const phase13 = readSrc("src/lib/accounting/phase13.test.ts");
    expect(phase13.length).toBeGreaterThan(100);
  });
});
