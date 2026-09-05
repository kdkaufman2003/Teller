import { describe, expect, it } from "vitest";
import { defaultAnswers, resolveIndustry } from "./registry";
import { tradesHvacPack } from "./trades-packs";

describe("HVAC trades industry pack", () => {
  it("seeds dealer-oriented books with jobs when HFAC is enabled", () => {
    const answers = {
      ...defaultAnswers(tradesHvacPack),
      connectHfac: true,
    };
    const resolved = resolveIndustry("trades-hvac", answers);

    expect(resolved.modules).toContain("jobs");
    expect(resolved.modules).toContain("hfac");
    expect(resolved.labels.customer).toBe("Dealers");
    expect(resolved.accounts.some((account) => account.code === "4000")).toBe(true);
    expect(resolved.accounts.some((account) => account.code === "1200")).toBe(false);
  });

  it("maps legacy hvac-trades id to HVAC pack", () => {
    const resolved = resolveIndustry("hvac-trades", defaultAnswers(tradesHvacPack));
    expect(resolved.pack.id).toBe("trades-hvac");
  });

  it("includes residential and commercial revenue when market segments selected", () => {
    const resolved = resolveIndustry("trades-hvac", {
      ...defaultAnswers(tradesHvacPack),
      marketSegments: ["residential"],
      revenueStreams: ["equipment", "labor", "service"],
      trackInventory: false,
      collectTax: false,
    });

    const codes = resolved.accounts.map((account) => account.code);
    expect(codes).toContain("4015");
    expect(codes).not.toContain("4025");
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

describe("Trade industry variants", () => {
  it("uses the same core accounts for electrical and plumbing", () => {
    const electrical = resolveIndustry("trades-electrical", {
      businessModel: "contractor",
      customerNoun: "customers",
      revenueStreams: ["equipment", "labor"],
      trackJobs: true,
      trackInventory: false,
      collectTax: false,
      warrantyReserve: false,
      basis: "accrual",
      fiscalYearStart: "1",
    });
    const plumbing = resolveIndustry("trades-plumbing", {
      businessModel: "service",
      customerNoun: "homeowners",
      revenueStreams: ["labor", "service"],
      trackJobs: true,
      trackInventory: false,
      collectTax: false,
      warrantyReserve: false,
      basis: "accrual",
      fiscalYearStart: "1",
    });

    expect(electrical.pack.name).toBe("Electrical");
    expect(plumbing.pack.name).toBe("Plumbing");
    expect(electrical.accounts.some((a) => a.code === "4100")).toBe(true);
    expect(plumbing.accounts.some((a) => a.code === "4200")).toBe(true);
  });
});
