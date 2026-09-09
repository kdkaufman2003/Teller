import { describe, expect, it } from "vitest";
import {
  canEditForecastLines,
  isImmutableForecastVersion,
} from "@/lib/planning/forecasts/lifecycle";
import {
  addMonths,
  isActualizedPeriod,
  rollingForwardMonths,
  ytdActualMonths,
} from "@/lib/planning/forecasts/periods";
import {
  applyPercentToAmounts,
  spreadTotalEvenly,
} from "@/lib/planning/forecasts/forecast-tools";
import { buildRollingForecastReport } from "@/lib/planning/reports/rolling-forecast";
import { normalizeOwnerFacingAmount } from "@/lib/planning/reports/variance";

const accounts = [
  { id: "rev", code: "4000", name: "Revenue", type: "revenue", archived: false },
  { id: "cogs", code: "5000", name: "COGS", type: "cogs", archived: false },
  { id: "exp", code: "6000", name: "Expense", type: "expense", archived: false },
];

describe("Phase 14D rolling forecast periods", () => {
  it("generates 12 forward months after anchor", () => {
    expect(rollingForwardMonths("2027-08-01", 12)).toEqual([
      "2027-09-01",
      "2027-10-01",
      "2027-11-01",
      "2027-12-01",
      "2028-01-01",
      "2028-02-01",
      "2028-03-01",
      "2028-04-01",
      "2028-05-01",
      "2028-06-01",
      "2028-07-01",
      "2028-08-01",
    ]);
  });

  it("crosses year boundary with addMonths", () => {
    expect(addMonths("2027-11-01", 3)).toBe("2028-02-01");
  });

  it("marks actualized periods through cutoff", () => {
    expect(isActualizedPeriod("2027-08-01", "2027-08-01")).toBe(true);
    expect(isActualizedPeriod("2027-09-01", "2027-08-01")).toBe(false);
  });

  it("builds YTD months through cutoff", () => {
    expect(ytdActualMonths("2027-08-01", "2027-08-01")).toHaveLength(8);
    expect(ytdActualMonths("2027-08-01", "2027-08-01")[7]).toBe("2027-08-01");
  });
});

describe("Phase 14D lifecycle", () => {
  it("allows draft edits only", () => {
    expect(canEditForecastLines("draft")).toBe(true);
    expect(canEditForecastLines("published")).toBe(false);
    expect(isImmutableForecastVersion("published", true)).toBe(true);
  });
});

describe("Phase 14D sign normalization", () => {
  it("normalizes revenue and expense to positive magnitudes", () => {
    expect(normalizeOwnerFacingAmount(-1000, "revenue")).toBe(1000);
    expect(normalizeOwnerFacingAmount(800, "expense")).toBe(800);
  });
});

describe("Phase 14D forecast tools", () => {
  it("applies percent adjustment with exact cents", () => {
    const amounts = new Map<string, number>([["rev::2027-09-01", 100]]);
    const next = applyPercentToAmounts(amounts, ["rev"], ["2027-09-01"], 10);
    expect(next.get("rev::2027-09-01")).toBe(110);
  });

  it("spreads annual total evenly", () => {
    const monthly = spreadTotalEvenly(1200, ["2027-09-01", "2027-10-01", "2027-11-01"]);
    expect(monthly.reduce((sum, value) => sum + value, 0)).toBe(1200);
  });
});

describe("Phase 14D rolling forecast blend", () => {
  it("blends GL actual YTD with forward forecast lines", () => {
    const forwardMonths = rollingForwardMonths("2027-08-01", 12);
    const forecastLineMap = new Map<string, number>([
      ["rev::2027-09-01", 5000],
      ["exp::2027-09-01", 1000],
    ]);
    const monthlyActuals = new Map<string, Map<string, number>>([
      ["rev", new Map([["2027-08-01", 4000]])],
      ["exp", new Map([["2027-08-01", 900]])],
    ]);

    const report = buildRollingForecastReport({
      forecast: {
        id: "f1",
        name: "Main forecast",
        anchor_month: "2027-08-01",
        horizon_months: 12,
      },
      version: {
        id: "v1",
        version_number: 1,
        label: "Version 1",
        status: "draft",
        is_immutable: false,
      },
      accounts,
      forecastLineMap,
      monthlyActuals,
      useStoredLinesOnly: false,
    });

    expect(report.ytdMonths).toHaveLength(8);
    expect(report.forwardMonths).toEqual(forwardMonths);
    expect(report.summary.revenue.ytdActual).toBe(4000);
    expect(report.summary.revenue.rollingTotal).toBe(5000);
    expect(report.summary.operatingIncome.rollingTotal).toBe(4000);
    expect(report.accounts.find((row) => row.accountId === "rev")?.periods[0]).toEqual({
      periodMonth: "2027-09-01",
      amount: 5000,
      kind: "forecast",
    });
  });

  it("uses stored lines only for published snapshots", () => {
    const forecastLineMap = new Map<string, number>([
      ["rev::2027-08-01", 4000],
      ["rev::2027-09-01", 5100],
    ]);

    const report = buildRollingForecastReport({
      forecast: {
        id: "f1",
        name: "Published",
        anchor_month: "2027-08-01",
        horizon_months: 12,
      },
      version: {
        id: "v1",
        version_number: 1,
        label: "Published",
        status: "published",
        is_immutable: true,
        published_at: "2027-09-01T00:00:00Z",
        actual_cutoff_month: "2027-08-01",
      },
      accounts,
      forecastLineMap,
      monthlyActuals: new Map(),
      useStoredLinesOnly: true,
      latestGlMonth: "2027-09-01",
    });

    expect(report.summary.revenue.ytdActual).toBe(4000);
    expect(report.summary.revenue.rollingTotal).toBe(5100);
    expect(report.staleForecast).toBe(true);
  });

  it("computes gross profit and operating income rollups", () => {
    const forecastLineMap = new Map<string, number>([
      ["rev::2027-09-01", 10000],
      ["cogs::2027-09-01", 4000],
      ["exp::2027-09-01", 3000],
    ]);

    const report = buildRollingForecastReport({
      forecast: {
        id: "f1",
        name: "Rollup",
        anchor_month: "2027-08-01",
        horizon_months: 1,
      },
      version: {
        id: "v1",
        version_number: 1,
        label: "Draft",
        status: "draft",
        is_immutable: false,
      },
      accounts,
      forecastLineMap,
      monthlyActuals: new Map(),
      useStoredLinesOnly: false,
    });

    expect(report.summary.grossProfit.rollingTotal).toBe(6000);
    expect(report.summary.operatingIncome.rollingTotal).toBe(3000);
  });

  it("includes forecast vs budget when budget map provided", () => {
    const forecastLineMap = new Map<string, number>([["rev::2027-09-01", 5500]]);
    const budgetLineMap = new Map<string, number>([["rev::2027-09-01", 5000]]);

    const report = buildRollingForecastReport({
      forecast: {
        id: "f1",
        name: "Vs budget",
        anchor_month: "2027-08-01",
        horizon_months: 1,
      },
      version: {
        id: "v1",
        version_number: 1,
        label: "Draft",
        status: "draft",
        is_immutable: false,
      },
      accounts,
      forecastLineMap,
      monthlyActuals: new Map(),
      budgetLineMap,
      useStoredLinesOnly: false,
    });

    const revenue = report.accounts.find((row) => row.accountId === "rev");
    expect(revenue?.budgetTotal).toBe(5000);
    expect(revenue?.forecastVsBudget?.varianceAmount).toBe(500);
  });
});
