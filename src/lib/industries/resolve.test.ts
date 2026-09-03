import { describe, expect, it } from "vitest";
import { defaultAnswers, resolveIndustry } from "./registry";
import { hvacTradesPack } from "./hvac-trades";

describe("HVAC industry pack", () => {
  it("seeds dealer-oriented books with jobs and HFAC integration", () => {
    const answers = defaultAnswers(hvacTradesPack);
    const resolved = resolveIndustry("hvac-trades", answers);

    expect(resolved.modules).toContain("jobs");
    expect(resolved.modules).toContain("hfac");
    expect(resolved.labels.customer).toBe("Dealers");
    expect(resolved.accounts.some((account) => account.code === "4000")).toBe(true);
    expect(resolved.accounts.some((account) => account.code === "1200")).toBe(false);
  });

  it("drops unused revenue accounts and keeps inventory when asked", () => {
    const resolved = resolveIndustry("hvac-trades", {
      ...defaultAnswers(hvacTradesPack),
      revenueStreams: ["equipment", "labor"],
      trackInventory: true,
      collectTax: false,
      warrantyReserve: false,
    });

    const codes = resolved.accounts.map((account) => account.code);
    expect(codes).toContain("1200");
    expect(codes).toContain("4000");
    expect(codes).toContain("4100");
    expect(codes).not.toContain("4200");
    expect(codes).not.toContain("2100");
    expect(codes).not.toContain("2200");
  });
});

describe("SaaS industry pack", () => {
  it("includes deferred revenue when recognition is over the term", () => {
    const resolved = resolveIndustry("saas", {
      billingModel: "subscription",
      customerNoun: "customers",
      recognition: "deferred",
      trackMrr: true,
      revenueStreams: ["subscription"],
      collectTax: false,
      basis: "accrual",
      fiscalYearStart: "1",
    });

    expect(resolved.modules).toContain("mrr");
    expect(resolved.modules).toContain("deferred-revenue");
    expect(resolved.accounts.some((account) => account.code === "2100")).toBe(true);
    expect(resolved.accounts.some((account) => account.code === "4100")).toBe(false);
  });
});
