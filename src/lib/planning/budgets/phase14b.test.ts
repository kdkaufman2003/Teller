import { describe, expect, it } from "vitest";
import { shiftPeriodMonth } from "@/lib/planning/budgets/prior-year-baseline";
import { copyForwardLines } from "@/lib/planning/budgets/copy-forward";
import {
  buildBudgetCsvPreview,
  escapeCsvField,
  exportBudgetCsv,
  parseBudgetCsvRows,
  parseBudgetMoney,
  sanitizeCsvExportCell,
} from "@/lib/planning/budgets/csv";
import { buildApprovalReview } from "@/lib/planning/budgets/approval-review";
import { isBudgetPnlAccount, BUDGET_PNL_ACCOUNT_TYPES } from "@/lib/planning/budgets/pnl-scope";
import { spreadAnnualEvenly, applyPercentChange } from "@/lib/planning/budgets/budget-tools";
import { assertLinesEditable } from "@/lib/planning/budgets/lifecycle";

const ORG = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ACCOUNTS = [
  {
    id: ACCOUNT_A,
    code: "4000",
    name: "Sales",
    organizationId: ORG,
    type: "revenue",
    archived: false,
  },
  {
    id: ACCOUNT_B,
    code: "6100",
    name: "Rent",
    organizationId: ORG,
    type: "expense",
    archived: false,
  },
];

describe("Phase 14B planning budgets", () => {
  it("maps prior-year months to target fiscal year", () => {
    expect(shiftPeriodMonth("2026-01-01", 1)).toBe("2027-01-01");
    expect(shiftPeriodMonth("2026-12-01", 1)).toBe("2027-12-01");
  });

  it("shifts copy-forward lines by fiscal year delta", () => {
    const source = [{ accountId: ACCOUNT_A, periodMonth: "2026-03-01", amount: 100 }];
    const copied = copyForwardLines(source, 2026, 2028);
    expect(copied[0]?.periodMonth).toBe("2028-03-01");
    expect(copied[0]?.amount).toBe(100);
  });

  it("scopes P&L eligibility for operating budgets", () => {
    expect(BUDGET_PNL_ACCOUNT_TYPES).toEqual(["revenue", "cogs", "expense"]);
    expect(isBudgetPnlAccount({ type: "revenue" })).toBe(true);
    expect(isBudgetPnlAccount({ type: "asset" })).toBe(false);
    expect(isBudgetPnlAccount({ type: "expense", archived: true })).toBe(false);
  });

  it("parses budget CSV money formats deterministically", () => {
    expect(parseBudgetMoney("1000", 1, "Jan")).toBe(1000);
    expect(parseBudgetMoney("1,000.25", 1, "Jan")).toBe(1000.25);
    expect(parseBudgetMoney("$1,000.25", 1, "Jan")).toBe(1000.25);
    expect(parseBudgetMoney("(250.00)", 1, "Jan")).toBe(-250);
    expect(parseBudgetMoney("-250.00", 1, "Jan")).toBe(-250);
    expect(() => parseBudgetMoney("abc", 2, "Feb")).toThrow(/Row 2/);
    expect(() => parseBudgetMoney("10.999", 3, "Mar")).toThrow(/Row 3/);
  });

  it("protects exported CSV text from formula injection", () => {
    expect(sanitizeCsvExportCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(sanitizeCsvExportCell("-250.00")).toBe("-250.00");
    expect(escapeCsvField('Account, "Special"')).toBe('"Account, ""Special"""');
  });

  it("validates CSV rows and rejects unknown accounts", () => {
    const csv = [
      "Account Number,Account Name,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec,Annual Total",
      "4000,Sales,100,200,0,0,0,0,0,0,0,0,0,0,300",
      "9999,Missing,50,0,0,0,0,0,0,0,0,0,0,0,50",
    ].join("\n");

    const preview = buildBudgetCsvPreview({
      content: csv,
      fiscalYear: 2027,
      organizationId: ORG,
      accounts: ACCOUNTS,
    });

    expect(preview.accountsMatched).toBe(1);
    expect(preview.accountsUnmatched).toBe(1);
    expect(preview.unmatched[0]?.message).toMatch(/9999 not found/i);
    expect(preview.lineCount).toBe(2);
    expect(preview.annualTotal).toBe(300);
  });

  it("detects duplicate account rows in CSV", () => {
    const csv = [
      "Account Number,Account Name,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec",
      "4000,Sales,100,0,0,0,0,0,0,0,0,0,0,0",
      "4000,Sales,200,0,0,0,0,0,0,0,0,0,0,0",
    ].join("\n");

    const preview = buildBudgetCsvPreview({
      content: csv,
      fiscalYear: 2027,
      organizationId: ORG,
      accounts: ACCOUNTS,
    });
    expect(preview.errors.some((issue) => /duplicate/i.test(issue.message))).toBe(true);
  });

  it("rejects foreign-org accounts during CSV preview", () => {
    const csv = [
      "Account Number,Account Name,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec",
      "4000,Sales,100,0,0,0,0,0,0,0,0,0,0,0",
    ].join("\n");

    const foreignAccount = { ...ACCOUNTS[0]!, organizationId: "other-org" };
    const preview = buildBudgetCsvPreview({
      content: csv,
      fiscalYear: 2027,
      organizationId: ORG,
      accounts: [foreignAccount],
    });
    expect(preview.accountsUnmatched).toBe(1);
  });

  it("exports budget CSV with month columns and annual total", () => {
    const csv = exportBudgetCsv({
      fiscalYear: 2027,
      accounts: [{ id: ACCOUNT_A, code: "4000", name: "Sales" }],
      lines: [
        { accountId: ACCOUNT_A, periodMonth: "2027-01-01", amount: 100.5 },
        { accountId: ACCOUNT_A, periodMonth: "2027-02-01", amount: 50.25 },
      ],
    });
    expect(csv.split("\n")[0]).toContain("Account Number");
    expect(csv).toContain("4000");
    expect(csv).toContain("150.75");
  });

  it("builds approval review with completeness warnings", () => {
    const review = buildApprovalReview({
      budgetName: "FY2027 Plan",
      fiscalYear: 2027,
      versionNumber: 1,
      versionLabel: "Version 1",
      status: "draft",
      lines: [{ accountId: ACCOUNT_A, periodMonth: "2027-01-01", amount: 100 }],
    });
    expect(review.warnings.length).toBeGreaterThan(0);
    expect(review.canApprove).toBe(true);
  });

  it("rejects line edits on approved and locked versions", () => {
    expect(() => assertLinesEditable("approved")).toThrow(/not editable/i);
    expect(() => assertLinesEditable("locked")).toThrow(/not editable/i);
  });

  it("spreads annual totals evenly across twelve months", () => {
    const months = spreadAnnualEvenly(1200);
    expect(months).toHaveLength(12);
    expect(months.reduce((sum, value) => sum + value, 0)).toBe(1200);
  });

  it("applies percent change to account months", () => {
    const cellKey = (accountId: string, periodMonth: string) => `${accountId}::${periodMonth}`;
    const amounts = {
      [cellKey(ACCOUNT_A, "2027-01-01")]: 100,
      [cellKey(ACCOUNT_A, "2027-02-01")]: 200,
    };
    const next = applyPercentChange(amounts, ACCOUNT_A, 2027, 10, cellKey);
    expect(next[cellKey(ACCOUNT_A, "2027-01-01")]).toBe(110);
    expect(next[cellKey(ACCOUNT_A, "2027-02-01")]).toBe(220);
  });

  it("parses budget CSV rows from standard template", () => {
    const rows = parseBudgetCsvRows(
      "Account Number,Account Name,Jan,Feb\n4000,Sales,100,200\n",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amounts[0]).toBe(100);
    expect(rows[0]?.amounts[1]).toBe(200);
  });
});
