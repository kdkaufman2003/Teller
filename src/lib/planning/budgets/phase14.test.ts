import { describe, expect, it } from "vitest";
import {
  actionToStatus,
  assertLinesEditable,
  assertVersionAction,
  assertVersionStatusTransition,
  canEditBudgetLines,
  isImmutableBudgetVersion,
} from "@/lib/planning/budgets/lifecycle";
import {
  fiscalYearCalendarMonths,
  isValidPeriodMonth,
  periodMonthInFiscalYear,
} from "@/lib/planning/budgets/periods";
import {
  accountAnnualTotal,
  budgetAnnualTotal,
  monthlyTotal,
} from "@/lib/planning/budgets/totals";
import {
  buildCloneLinePayload,
  detectDuplicateLines,
  parseBudgetAmount,
  validateAccountForBudgetLine,
  validateBulkLines,
  validateBudgetName,
  validateFiscalYear,
} from "@/lib/planning/budgets/validation";
import { DEFAULT_PLANNING_SETTINGS, parsePlanningSettings } from "@/lib/planning/settings/planning-settings";
import { planningOwnerLabel } from "@/lib/planning/presentation-labels";

const ORG = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("Phase 14A planning budgets", () => {
  it("validates budget name and fiscal year", () => {
    expect(() => validateBudgetName("")).toThrow(/required/i);
    expect(() => validateFiscalYear(1899)).toThrow(/1900/);
    validateFiscalYear(2027);
  });

  it("generates twelve fiscal-year calendar months", () => {
    const months = fiscalYearCalendarMonths(2027);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2027-01-01");
    expect(months[11]).toBe("2027-12-01");
  });

  it("validates period month format and fiscal year membership", () => {
    expect(isValidPeriodMonth("2027-03-01")).toBe(true);
    expect(isValidPeriodMonth("2027-03-15")).toBe(false);
    expect(isValidPeriodMonth("2027-13-01")).toBe(false);
    expect(periodMonthInFiscalYear("2027-03-01", 2027)).toBe(true);
    expect(periodMonthInFiscalYear("2026-12-01", 2027)).toBe(false);
  });

  it("parses budget amounts with cents precision", () => {
    expect(parseBudgetAmount("10.005")).toBe(10.01);
    expect(parseBudgetAmount("")).toBe(0);
    expect(parseBudgetAmount(-125.5)).toBe(-125.5);
  });

  it("detects duplicate account/period lines", () => {
    const dup = detectDuplicateLines([
      { accountId: ACCOUNT_A, periodMonth: "2027-01-01", amount: 1 },
      { accountId: ACCOUNT_A, periodMonth: "2027-01-01", amount: 2 },
    ]);
    expect(dup).toContain(ACCOUNT_A);
  });

  it("rejects cross-org GL accounts", () => {
    expect(() =>
      validateAccountForBudgetLine(
        { id: ACCOUNT_A, organizationId: "other-org", code: "4000", archived: false },
        ORG,
      ),
    ).toThrow(/organization/i);
    expect(() =>
      validateAccountForBudgetLine(
        { id: ACCOUNT_A, organizationId: ORG, code: "4000", archived: true },
        ORG,
      ),
    ).toThrow(/archived/i);
  });

  it("validates bulk lines for draft versions only", () => {
    const accounts = new Map([
      [ACCOUNT_A, { id: ACCOUNT_A, organizationId: ORG, code: "4000", archived: false }],
    ]);
    const lines = validateBulkLines({
      lines: [{ accountId: ACCOUNT_A, periodMonth: "2027-01-01", amount: 100 }],
      fiscalYear: 2027,
      organizationId: ORG,
      versionStatus: "draft",
      accountsById: accounts,
    });
    expect(lines[0]?.amount).toBe(100);

    expect(() =>
      validateBulkLines({
        lines: [{ accountId: ACCOUNT_A, periodMonth: "2027-01-01", amount: 1 }],
        fiscalYear: 2027,
        organizationId: ORG,
        versionStatus: "approved",
        accountsById: accounts,
      }),
    ).toThrow(/not editable/i);
  });

  it("enforces version lifecycle transitions", () => {
    expect(canEditBudgetLines("draft")).toBe(true);
    expect(canEditBudgetLines("submitted")).toBe(true);
    expect(canEditBudgetLines("approved")).toBe(false);
    expect(isImmutableBudgetVersion("locked")).toBe(true);

    assertVersionAction("draft", "approve");
    expect(actionToStatus("lock")).toBe("locked");

    expect(() => assertVersionStatusTransition("locked", "draft")).toThrow(/Cannot transition/);
    expect(() => assertLinesEditable("approved")).toThrow(/not editable/i);
  });

  it("computes monthly, account, and budget totals deterministically", () => {
    const lines = [
      { accountId: ACCOUNT_A, periodMonth: "2027-01-01", amount: 100.1 },
      { accountId: ACCOUNT_A, periodMonth: "2027-02-01", amount: 50.2 },
      { accountId: ACCOUNT_B, periodMonth: "2027-01-01", amount: 25.25 },
    ];
    expect(monthlyTotal(lines, "2027-01-01")).toBe(125.35);
    expect(accountAnnualTotal(lines, ACCOUNT_A)).toBe(150.3);
    expect(budgetAnnualTotal(lines)).toBe(175.55);
  });

  it("builds clone line payload without mutating source semantics", () => {
    const source = [{ accountId: ACCOUNT_A, periodMonth: "2027-01-01", amount: 500 }];
    const cloned = buildCloneLinePayload(source, "new-version-id");
    expect(cloned[0]?.sourceKind).toBe("clone");
    expect(cloned[0]?.budgetVersionId).toBe("new-version-id");
    expect(source[0]?.amount).toBe(500);
  });

  it("parses planning settings defaults", () => {
    expect(parsePlanningSettings(null)).toEqual(DEFAULT_PLANNING_SETTINGS);
    expect(parsePlanningSettings({ default_ar_collection_days: 45 }).defaultArCollectionDays).toBe(45);
  });

  it("uses owner-friendly planning labels", () => {
    expect(planningOwnerLabel("Budget")).toBe("Plan");
    expect(planningOwnerLabel("Vs Plan")).toBe("Vs plan");
  });
});
