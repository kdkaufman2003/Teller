import { describe, expect, it } from "vitest";
import { documentRemainingBalance } from "./balances";

describe("authoritative balance calculations", () => {
  it("derives remaining AR/AP from authoritative paid amount", () => {
    expect(documentRemainingBalance(1500, 500)).toBe(1000);
    expect(documentRemainingBalance(1000, 1000)).toBe(0);
  });

  it("never returns negative remaining balance", () => {
    expect(documentRemainingBalance(1000, 1200)).toBe(0);
  });
});
