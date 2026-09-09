import { describe, expect, it } from "vitest";
import { applyForecastAssumptions } from "@/lib/planning/forecasts/assumption-engine";
import { validateAssumptionInput, parseAssumptionRecord } from "@/lib/planning/forecasts/assumption-validation";
import { loadManualOverrideMap } from "@/lib/planning/forecasts/forecast-refresh";
import type { ForecastAssumptionRecord } from "@/lib/planning/forecasts/types";

const accounts = [
  { id: "rev", code: "4000", name: "Revenue", type: "revenue" },
  { id: "cogs", code: "5000", name: "COGS", type: "cogs" },
  { id: "exp", code: "6000", name: "Expense", type: "expense" },
  { id: "rent", code: "6100", name: "Rent", type: "expense" },
];

const forwardMonths = ["2027-03-01", "2027-04-01", "2027-12-01"];
const cutoff = "2027-02-01";

function baseline(values: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(values));
}

function assumption(partial: Partial<ForecastAssumptionRecord>): ForecastAssumptionRecord {
  return {
    id: partial.id ?? "a1",
    name: partial.name ?? "Assumption",
    description: "",
    assumptionKind: "revenue_growth",
    assumptionType: "percentage_change",
    targetScope: "all_revenue",
    valueType: "percentage",
    valueNumeric: 8,
    valueText: null,
    effectiveStartMonth: null,
    effectiveEndMonth: null,
    targetAccountId: null,
    parameters: {},
    priority: 100,
    ...partial,
  };
}

describe("Phase 14E assumption validation", () => {
  it("rejects foreign target account", () => {
    expect(() =>
      validateAssumptionInput(
        {
          name: "Rent",
          assumptionType: "fixed_monthly_amount",
          targetScope: "account",
          targetAccountId: "missing",
          valueNumeric: 5000,
          valueType: "currency",
        },
        new Map(),
      ),
    ).toThrow(/not found/);
  });

  it("parses assumption type from parameters", () => {
    const parsed = parseAssumptionRecord({
      id: "x",
      name: "Growth",
      assumption_kind: "revenue_growth",
      value_type: "percentage",
      value_numeric: 5,
      parameters: { assumptionType: "percentage_change", targetScope: "all_revenue" },
    });
    expect(parsed.assumptionType).toBe("percentage_change");
    expect(parsed.targetScope).toBe("all_revenue");
  });
});

describe("Phase 14E assumption engine", () => {
  it("applies revenue growth against baseline idempotently", () => {
    const base = baseline({
      "rev::2027-03-01": 10000,
      "rev::2027-04-01": 10000,
    });
    const assumptions = [
      assumption({
        assumptionType: "percentage_change",
        targetScope: "all_revenue",
        valueNumeric: 8,
      }),
    ];
    const first = applyForecastAssumptions({
      accounts,
      forwardMonths,
      actualCutoffMonth: cutoff,
      baseline: base,
      manualOverrides: new Map(),
      assumptions,
    });
    const second = applyForecastAssumptions({
      accounts,
      forwardMonths,
      actualCutoffMonth: cutoff,
      baseline: base,
      manualOverrides: new Map(),
      assumptions,
    });
    expect(first.effectiveValues.get("rev::2027-03-01")).toBe(10800);
    expect(second.effectiveValues.get("rev::2027-03-01")).toBe(10800);
  });

  it("applies COGS percentage increase", () => {
    const result = applyForecastAssumptions({
      accounts,
      forwardMonths: ["2027-03-01"],
      actualCutoffMonth: cutoff,
      baseline: baseline({ "cogs::2027-03-01": 4000 }),
      manualOverrides: new Map(),
      assumptions: [
        assumption({
          id: "cogs",
          assumptionType: "percentage_change",
          targetScope: "all_cogs",
          assumptionKind: "material_inflation",
          valueNumeric: 4,
        }),
      ],
    });
    expect(result.effectiveValues.get("cogs::2027-03-01")).toBe(4160);
  });

  it("applies fixed monthly amount for selected account from effective start", () => {
    const result = applyForecastAssumptions({
      accounts,
      forwardMonths,
      actualCutoffMonth: cutoff,
      baseline: baseline({
        "rent::2027-03-01": 3000,
        "rent::2027-04-01": 3000,
      }),
      manualOverrides: new Map(),
      assumptions: [
        assumption({
          id: "rent",
          name: "Rent increase",
          assumptionType: "fixed_monthly_amount",
          targetScope: "account",
          targetAccountId: "rent",
          valueNumeric: 5000,
          effectiveStartMonth: "2027-04-01",
        }),
      ],
    });
    expect(result.effectiveValues.get("rent::2027-03-01")).toBe(3000);
    expect(result.effectiveValues.get("rent::2027-04-01")).toBe(5000);
  });

  it("applies seasonal month multiplier", () => {
    const result = applyForecastAssumptions({
      accounts,
      forwardMonths,
      actualCutoffMonth: cutoff,
      baseline: baseline({
        "rev::2027-03-01": 10000,
        "rev::2027-12-01": 10000,
      }),
      manualOverrides: new Map(),
      assumptions: [
        assumption({
          id: "dec",
          assumptionType: "month_multiplier",
          targetScope: "all_revenue",
          assumptionKind: "seasonality",
          valueNumeric: 20,
          parameters: { month: 12 },
        }),
      ],
    });
    expect(result.effectiveValues.get("rev::2027-03-01")).toBe(10000);
    expect(result.effectiveValues.get("rev::2027-12-01")).toBe(12000);
  });

  it("derives COGS from target gross margin", () => {
    const result = applyForecastAssumptions({
      accounts,
      forwardMonths: ["2027-03-01"],
      actualCutoffMonth: cutoff,
      baseline: baseline({
        "rev::2027-03-01": 100000,
        "cogs::2027-03-01": 50000,
      }),
      manualOverrides: new Map(),
      assumptions: [
        assumption({
          id: "margin",
          assumptionType: "target_margin",
          targetScope: "all_cogs",
          valueNumeric: 40,
          priority: 200,
        }),
      ],
    });
    expect(result.effectiveValues.get("cogs::2027-03-01")).toBe(60000);
    expect(result.summary.grossProfit.after).toBe(40000);
  });

  it("preserves manual override precedence", () => {
    const result = applyForecastAssumptions({
      accounts,
      forwardMonths: ["2027-03-01"],
      actualCutoffMonth: cutoff,
      baseline: baseline({ "rev::2027-03-01": 10000 }),
      manualOverrides: new Map([["rev::2027-03-01", 125000]]),
      assumptions: [
        assumption({
          assumptionType: "percentage_change",
          targetScope: "all_revenue",
          valueNumeric: 8,
        }),
      ],
    });
    expect(result.effectiveValues.get("rev::2027-03-01")).toBe(125000);
    expect(result.cellMeta.get("rev::2027-03-01")?.source).toBe("manual");
  });

  it("does not apply assumptions to actualized periods", () => {
    const result = applyForecastAssumptions({
      accounts,
      forwardMonths: ["2027-01-01", "2027-03-01"],
      actualCutoffMonth: "2027-02-01",
      baseline: baseline({
        "rev::2027-01-01": 9000,
        "rev::2027-03-01": 10000,
      }),
      manualOverrides: new Map(),
      assumptions: [
        assumption({
          assumptionType: "percentage_change",
          targetScope: "all_revenue",
          valueNumeric: 10,
        }),
      ],
    });
    expect(result.effectiveValues.has("rev::2027-01-01")).toBe(false);
    expect(result.effectiveValues.get("rev::2027-03-01")).toBe(11000);
  });

  it("loads manual overrides from line source kinds", () => {
    const overrides = loadManualOverrideMap(
      [
        {
          account_id: "rev",
          period_month: "2027-03-01",
          amount: 500,
          source_kind: "manual",
        },
        {
          account_id: "rev",
          period_month: "2027-04-01",
          amount: 600,
          source_kind: "assumption",
        },
      ],
      forwardMonths,
    );
    expect(overrides.get("rev::2027-03-01")).toBe(500);
    expect(overrides.has("rev::2027-04-01")).toBe(false);
  });

  it("computes preview summary deltas", () => {
    const result = applyForecastAssumptions({
      accounts,
      forwardMonths: ["2027-03-01"],
      actualCutoffMonth: cutoff,
      baseline: baseline({
        "rev::2027-03-01": 10000,
        "cogs::2027-03-01": 4000,
        "exp::2027-03-01": 2000,
      }),
      manualOverrides: new Map(),
      assumptions: [
        assumption({
          assumptionType: "percentage_change",
          targetScope: "all_revenue",
          valueNumeric: 10,
        }),
      ],
    });
    expect(result.summary.revenue.change).toBe(1000);
    expect(result.summary.operatingIncome.after).toBe(
      result.summary.revenue.after - result.summary.cogs.after - result.summary.expenses.after,
    );
  });
});
