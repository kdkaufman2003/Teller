import { describe, expect, it } from "vitest";
import {
  invoicePaymentStatus,
  mapHfacJobType,
  quoteCogsBreakdown,
  quoteJobMetadata,
} from "./hfac-quote";
import type { HfacWonQuote } from "./hfac";

describe("mapHfacJobType", () => {
  it("maps service and repair deals", () => {
    expect(mapHfacJobType("Residential Service")).toBe("service");
    expect(mapHfacJobType("AC Repair")).toBe("service");
  });

  it("maps maintenance and warranty deals", () => {
    expect(mapHfacJobType("Maintenance Agreement")).toBe("maintenance");
    expect(mapHfacJobType("Warranty callback")).toBe("warranty");
  });

  it("defaults to install", () => {
    expect(mapHfacJobType("Replacement")).toBe("install");
    expect(mapHfacJobType(undefined)).toBe("install");
  });
});

describe("quoteCogsBreakdown", () => {
  it("reads dollar and nested cogs fields", () => {
    const quote: HfacWonQuote = {
      id: "q-1",
      equipment_cost: 6100,
      labor_cost: 2000,
      materials_cost: 825,
      salesperson: "Alex",
      cogs: { materials: 999 },
    };

    expect(quoteCogsBreakdown(quote)).toEqual({
      equipment: 6100,
      labor: 2000,
      materials: 825,
      salesperson: "Alex",
    });
  });

  it("converts cent fields when provided", () => {
    expect(
      quoteCogsBreakdown({
        id: "q-2",
        equipment_cost_cents: 610000,
        labor_cost_cents: 200000,
      }),
    ).toMatchObject({
      equipment: 6100,
      labor: 2000,
    });
  });
});

describe("quoteJobMetadata", () => {
  it("stores HFAC quote context on the job", () => {
    const metadata = quoteJobMetadata({
      id: "q-3",
      source: "deal",
      salesperson: "Jordan",
      equipment_cost: 100,
      labor_cost: 50,
      materials_cost: 25,
    });

    expect(metadata.hfac).toMatchObject({
      source: "deal",
      quote_id: "q-3",
      salesperson: "Jordan",
      cogs: { equipment: 100, labor: 50, materials: 25, salesperson: "Jordan" },
    });
  });
});

describe("invoicePaymentStatus", () => {
  it("keeps invoice open after a partial payment", () => {
    expect(invoicePaymentStatus(0, 500, 1500)).toEqual({
      amountPaid: 500,
      fullyPaid: false,
    });
  });

  it("marks invoice paid when cumulative payments reach total", () => {
    expect(invoicePaymentStatus(1000, 500, 1500)).toEqual({
      amountPaid: 1500,
      fullyPaid: true,
    });
  });
});
