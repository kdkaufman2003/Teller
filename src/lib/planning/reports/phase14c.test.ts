import { describe, expect, it } from "vitest";
import { buildBudgetVsActualReport } from "@/lib/planning/reports/budget-vs-actual";
import {
  computeVarianceAmounts,
  formatVariancePercent,
  normalizeOwnerFacingAmount,
  varianceAmount,
  variancePercent,
  varianceStatus,
} from "@/lib/planning/reports/variance";

const REV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COGS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EXP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UNBUDGETED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("Phase 14C budget vs actual variance", () => {
  it("uses actual minus budget for dollar variance", () => {
    expect(varianceAmount(1200, 1000)).toBe(200);
    expect(varianceAmount(800, 1000)).toBe(-200);
  });

  it("marks revenue favorable when actual exceeds budget", () => {
    expect(varianceStatus(1200, 1000, "revenue")).toBe("favorable");
    expect(varianceStatus(800, 1000, "revenue")).toBe("unfavorable");
  });

  it("marks expense and COGS favorable when actual is below budget", () => {
    expect(varianceStatus(800, 1000, "expense")).toBe("favorable");
    expect(varianceStatus(1200, 1000, "expense")).toBe("unfavorable");
    expect(varianceStatus(400, 500, "cogs")).toBe("favorable");
    expect(varianceStatus(600, 500, "cogs")).toBe("unfavorable");
  });

  it("handles zero denominator percentage safely", () => {
    expect(variancePercent(0, 0)).toBe(0);
    expect(variancePercent(100, 0)).toBeNull();
    expect(formatVariancePercent(null)).toBe("N/M");
  });

  it("normalizes owner-facing signs for P&L types", () => {
    expect(normalizeOwnerFacingAmount(-500, "expense")).toBe(500);
    expect(normalizeOwnerFacingAmount(500, "revenue")).toBe(500);
  });

  it("builds YTD and category rollups with gross profit and operating income", () => {
    const monthlyActuals = new Map<string, Map<string, number>>([
      [REV, new Map([["2027-01-01", 1100], ["2027-02-01", 1000]])],
      [COGS, new Map([["2027-01-01", 400], ["2027-02-01", 450]])],
      [EXP, new Map([["2027-01-01", 150], ["2027-02-01", 100]])],
    ]);

    const report = buildBudgetVsActualReport({
      fiscalYear: 2027,
      throughMonth: "2027-02-01",
      version: {
        id: "version-1",
        versionNumber: 1,
        label: "Approved",
        status: "approved",
        budgetId: "budget-1",
        budgetName: "FY2027 Plan",
      },
      accounts: [
        { id: REV, code: "4000", name: "Revenue", type: "revenue", archived: false },
        { id: COGS, code: "5000", name: "COGS", type: "cogs", archived: false },
        { id: EXP, code: "6000", name: "Expense", type: "expense", archived: false },
      ],
      budgetLines: [
        { accountId: REV, periodMonth: "2027-01-01", amount: 1000 },
        { accountId: REV, periodMonth: "2027-02-01", amount: 1000 },
        { accountId: COGS, periodMonth: "2027-01-01", amount: 500 },
        { accountId: COGS, periodMonth: "2027-02-01", amount: 500 },
        { accountId: EXP, periodMonth: "2027-01-01", amount: 200 },
        { accountId: EXP, periodMonth: "2027-02-01", amount: 200 },
      ],
      monthlyActuals,
    });

    expect(report.summary.revenue.actual).toBe(2100);
    expect(report.summary.revenue.budget).toBe(2000);
    expect(report.summary.grossProfit.actual).toBe(1250);
    expect(report.summary.operatingIncome.actual).toBe(1000);
    expect(report.categories.find((row) => row.category === "gross_profit")?.ytd.varianceAmount).toBe(250);
  });

  it("surfaces unbudgeted actual activity", () => {
    const report = buildBudgetVsActualReport({
      fiscalYear: 2027,
      throughMonth: "2027-01-01",
      version: {
        id: "version-1",
        versionNumber: 1,
        label: "Approved",
        status: "approved",
        budgetId: "budget-1",
        budgetName: "FY2027 Plan",
      },
      accounts: [
        { id: UNBUDGETED, code: "6100", name: "Misc", type: "expense", archived: false },
      ],
      budgetLines: [],
      monthlyActuals: new Map([[UNBUDGETED, new Map([["2027-01-01", 250]])]]),
    });

    const row = report.accounts.find((entry) => entry.accountId === UNBUDGETED);
    expect(row?.isUnbudgeted).toBe(true);
    expect(row?.ytd.status).toBe("unbudgeted");
  });

  it("shows budget without actual activity", () => {
    const report = buildBudgetVsActualReport({
      fiscalYear: 2027,
      throughMonth: "2027-01-01",
      version: {
        id: "version-1",
        versionNumber: 1,
        label: "Approved",
        status: "approved",
        budgetId: "budget-1",
        budgetName: "FY2027 Plan",
      },
      accounts: [{ id: EXP, code: "6000", name: "Marketing", type: "expense", archived: false }],
      budgetLines: [{ accountId: EXP, periodMonth: "2027-01-01", amount: 10000 }],
      monthlyActuals: new Map([[EXP, new Map([["2027-01-01", 0]])]]),
    });

    const row = report.accounts.find((entry) => entry.accountId === EXP);
    expect(row?.hasBudgetWithoutActual).toBe(true);
    expect(row?.ytd.budget).toBe(10000);
    expect(row?.ytd.actual).toBe(0);
  });

  it("preserves exact cents in variance amounts", () => {
    const result = computeVarianceAmounts(1000.33, 900.12, "revenue");
    expect(result.varianceAmount).toBe(100.21);
  });

  it("flags draft versions for preview labeling", () => {
    const report = buildBudgetVsActualReport({
      fiscalYear: 2027,
      throughMonth: "2027-01-01",
      version: {
        id: "version-1",
        versionNumber: 2,
        label: "Draft",
        status: "draft",
        budgetId: "budget-1",
        budgetName: "FY2027 Plan",
      },
      accounts: [{ id: REV, code: "4000", name: "Revenue", type: "revenue", archived: false }],
      budgetLines: [{ accountId: REV, periodMonth: "2027-01-01", amount: 1000 }],
      monthlyActuals: new Map([[REV, new Map([["2027-01-01", 900]])]]),
    });
    expect(report.version.isDraft).toBe(true);
  });
});
