import { describe, expect, it } from "vitest";
import {
  collectTaxEnabled,
  fiscalQuarterIndex,
  fiscalYearStartDate,
  organizationSourceFromPartner,
  parseFiscalYearStart,
  resolveOrgTaxRate,
  resolveOrgTaxMode,
  readOrgAccountingConfig,
} from "./config";

describe("parseFiscalYearStart", () => {
  it("defaults invalid values to January", () => {
    expect(parseFiscalYearStart(undefined)).toBe(1);
    expect(parseFiscalYearStart("13")).toBe(1);
  });

  it("accepts valid month numbers", () => {
    expect(parseFiscalYearStart("4")).toBe(4);
  });
});

describe("resolveOrgTaxRate", () => {
  it("returns zero when tax collection is disabled", () => {
    expect(resolveOrgTaxRate({ collectTax: false, taxRate: 8.5 })).toBe(0);
  });

  it("returns configured rate when collection is enabled", () => {
    expect(resolveOrgTaxRate({ collectTax: true, taxRate: 8.975 })).toBe(8.975);
  });

  it("infers collection from positive rate when collectTax unset", () => {
    expect(collectTaxEnabled({ taxRate: 7 })).toBe(true);
    expect(resolveOrgTaxRate({ taxRate: 7 })).toBe(7);
  });
});

describe("resolveOrgTaxMode", () => {
  it("defaults to flat rate mode", () => {
    expect(resolveOrgTaxMode({})).toBe("flat");
    expect(readOrgAccountingConfig({}).taxMode).toBe("flat");
  });

  it("supports jurisdiction mode when configured", () => {
    expect(resolveOrgTaxMode({ taxMode: "jurisdiction" })).toBe("jurisdiction");
  });
});

describe("organizationSourceFromPartner", () => {
  it("maps HFAC partner to hfac source", () => {
    expect(organizationSourceFromPartner("hasslefreeac")).toBe("hfac");
  });

  it("maps other partners and direct signup", () => {
    expect(organizationSourceFromPartner("other")).toBe("partner");
    expect(organizationSourceFromPartner(null)).toBe("direct");
  });
});

describe("fiscalYearStartDate", () => {
  it("uses prior calendar year when today is before fiscal start", () => {
    const start = fiscalYearStartDate(new Date("2026-02-15"), 4);
    expect(start.getFullYear()).toBe(2025);
    expect(start.getMonth()).toBe(3);
  });

  it("computes fiscal quarter within non-calendar fiscal year", () => {
    const today = new Date("2026-05-15");
    expect(fiscalQuarterIndex(today, 4)).toBe(0);
    expect(fiscalYearStartDate(today, 4).getMonth()).toBe(3);
  });
});
