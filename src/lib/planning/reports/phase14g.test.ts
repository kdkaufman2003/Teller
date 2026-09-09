import { describe, expect, it } from "vitest";
import {
  computeOpenReceiptQuantity,
  computeOpenReceiptValue,
} from "@/lib/accounting/inventory/grni/settlement";
import {
  depreciationExcludedFromCash,
  parseOverridePlanningCategory,
  projectCapexCash,
} from "@/lib/planning/cash/capex-adapter";
import {
  dedupeCashFlowLines,
  filterProjectedPayrollWhenPosted,
  filterRecurringWhenBillExists,
} from "@/lib/planning/cash/dedupe";
import { aggregateWeeklyCash, buildCashWarnings } from "@/lib/planning/cash/engine";
import { projectPayrollDates } from "@/lib/planning/cash/payroll-cadence";
import {
  advanceRecurrenceDate,
  generateRecurrenceOccurrences,
  paymentDateFromOccurrence,
} from "@/lib/planning/cash/recurrence-dates";
import { isNonCashRecurringSchedule } from "@/lib/planning/cash/recurring-adapter";
import { buildSourceCoverage } from "@/lib/planning/cash/source-coverage";
import type { CashFlowLine } from "@/lib/planning/cash/types";
import { buildCashHorizonWeeks } from "@/lib/planning/cash/weeks";

describe("Phase 14G payroll cadence", () => {
  it("projects biweekly pay dates within horizon", () => {
    const dates = projectPayrollDates({
      cadence: "biweekly",
      anchorPayDate: "2027-09-01",
      fromDate: "2027-09-08",
      throughDate: "2027-10-15",
    });
    expect(dates.length).toBeGreaterThan(0);
    expect(dates[0]).toBe("2027-09-15");
  });

  it("excludes projected payroll when posted run exists for same date", () => {
    const lines: CashFlowLine[] = [
      {
        weekIndex: 1,
        periodStart: "2027-09-06",
        periodEnd: "2027-09-12",
        flowKind: "outflow",
        category: "payroll",
        amount: 5000,
        sourceKind: "payroll_posted",
        sourceId: "run-1",
        label: "Payroll",
        explanation: "Posted",
        metadata: { dedupeKey: "payroll:run:run-1", payDate: "2027-09-15" },
      },
      {
        weekIndex: 2,
        periodStart: "2027-09-13",
        periodEnd: "2027-09-19",
        flowKind: "outflow",
        category: "payroll",
        amount: 5000,
        sourceKind: "payroll_projection",
        sourceId: "projected:2027-09-15",
        label: "Payroll",
        explanation: "Projected",
        metadata: { payDate: "2027-09-15" },
      },
    ];
    const filtered = filterProjectedPayrollWhenPosted(lines, new Set(["2027-09-15"]));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.sourceKind).toBe("payroll_posted");
  });
});

describe("Phase 14G recurring", () => {
  it("generates monthly occurrences inside horizon", () => {
    const dates = generateRecurrenceOccurrences({
      recurrence: "monthly",
      startDate: "2027-01-15",
      endDate: null,
      fromDate: "2027-09-01",
      throughDate: "2027-11-30",
      issueDayOfMonth: 15,
    });
    expect(dates).toEqual(["2027-09-15", "2027-10-15", "2027-11-15"]);
  });

  it("computes payment date from occurrence and due days", () => {
    expect(paymentDateFromOccurrence("2027-09-01", 30)).toBe("2027-10-01");
  });

  it("advances weekly recurrence", () => {
    expect(advanceRecurrenceDate("weekly", "2027-09-01")).toBe("2027-09-08");
  });

  it("excludes recurring forecast when posted bill exists", () => {
    const lines: CashFlowLine[] = [
      {
        weekIndex: 1,
        periodStart: "2027-09-06",
        periodEnd: "2027-09-12",
        flowKind: "outflow",
        category: "recurring",
        amount: 1200,
        sourceKind: "recurring_bill",
        sourceId: "tpl-1",
        label: "Rent",
        explanation: "Recurring",
        metadata: { dedupeKey: "recurring:tpl-1:2027-09-01" },
      },
    ];
    const filtered = filterRecurringWhenBillExists(lines, new Set(["recurring:tpl-1:2027-09-01"]));
    expect(filtered).toHaveLength(0);
  });

  it("excludes non-cash recurring schedule types", () => {
    expect(isNonCashRecurringSchedule("prepaid_expense")).toBe(true);
    expect(isNonCashRecurringSchedule("depreciation")).toBe(true);
    expect(isNonCashRecurringSchedule("accrued_expense")).toBe(false);
  });
});

describe("Phase 14G purchasing precedence", () => {
  it("computes open GRNI value after partial bill match", () => {
    const openValue = computeOpenReceiptValue({
      receiptLineId: "rl-1",
      quantityReceived: 8000,
      quantityMatched: 5000,
      receiptValue: 8000,
      valueMatched: 5000,
    });
    expect(openValue).toBe(3000);
  });

  it("computes open receipt quantity", () => {
    const openQty = computeOpenReceiptQuantity({
      receiptLineId: "rl-1",
      quantityReceived: 8,
      quantityMatched: 5,
      receiptValue: 8000,
      valueMatched: 5000,
    });
    expect(openQty).toBe(3);
  });

  it("prefers AP bill over GRNI and PO by dedupe precedence", () => {
    const lines: CashFlowLine[] = [
      {
        weekIndex: 1,
        periodStart: "2027-09-06",
        periodEnd: "2027-09-12",
        flowKind: "outflow",
        category: "ap_payment",
        amount: 5000,
        sourceKind: "ap_bill",
        sourceId: "bill-1",
        label: "Bill",
        explanation: "AP",
        metadata: { dedupeKey: "ap:bill-1" },
      },
      {
        weekIndex: 1,
        periodStart: "2027-09-06",
        periodEnd: "2027-09-12",
        flowKind: "outflow",
        category: "purchasing",
        amount: 5000,
        sourceKind: "grni_receipt_line",
        sourceId: "rl-1",
        label: "GRNI",
        explanation: "GRNI",
        metadata: { dedupeKey: "ap:bill-1" },
      },
    ];
    const { lines: deduped, diagnostics } = dedupeCashFlowLines(lines);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.sourceKind).toBe("ap_bill");
    expect(diagnostics.droppedCount).toBe(1);
  });

  it("keeps separate PO and GRNI when dedupe keys differ", () => {
    const lines: CashFlowLine[] = [
      {
        weekIndex: 2,
        periodStart: "2027-09-13",
        periodEnd: "2027-09-19",
        flowKind: "outflow",
        category: "purchasing",
        amount: 2000,
        sourceKind: "grni_receipt_line",
        sourceId: "rl-1",
        label: "GRNI",
        explanation: "GRNI",
        metadata: { dedupeKey: "grni:line:rl-1" },
      },
      {
        weekIndex: 3,
        periodStart: "2027-09-20",
        periodEnd: "2027-09-26",
        flowKind: "outflow",
        category: "purchasing",
        amount: 2000,
        sourceKind: "po_line_commitment",
        sourceId: "pol-1",
        label: "PO",
        explanation: "PO",
        metadata: { dedupeKey: "po:line:pol-1" },
      },
    ];
    const { lines: deduped } = dedupeCashFlowLines(lines);
    expect(deduped).toHaveLength(2);
  });
});

describe("Phase 14G capex", () => {
  it("includes planned capex overrides only", () => {
    const { weeks } = buildCashHorizonWeeks("2027-09-08", 13);
    const { lines } = projectCapexCash({
      organizationId: "org-1",
      horizonWeeks: weeks,
      horizonStart: weeks[0]!.periodStart,
      horizonEnd: weeks[12]!.periodEnd,
      overrides: [
        {
          id: "o1",
          effectiveDate: weeks[1]!.periodStart,
          flowKind: "outflow",
          amount: 55000,
          label: "Service van",
          notes: "capex:Fleet purchase",
        },
        {
          id: "o2",
          effectiveDate: weeks[1]!.periodStart,
          flowKind: "outflow",
          amount: 1000,
          label: "General",
          notes: "",
        },
      ],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.category).toBe("capex");
    expect(lines[0]!.amount).toBe(55000);
  });

  it("parses capex category from notes prefix", () => {
    expect(parseOverridePlanningCategory("capex:New van")).toBe("capex");
    expect(parseOverridePlanningCategory("general note")).toBe("general");
  });

  it("excludes depreciation from cash planning", () => {
    expect(depreciationExcludedFromCash()).toBe(true);
  });
});

describe("Phase 14G global integration", () => {
  it("aggregates all adapter categories with exact cents roll-forward", () => {
    const { weeks } = buildCashHorizonWeeks("2027-09-08", 13);
    const flowLines: CashFlowLine[] = [
      {
        weekIndex: 1,
        periodStart: weeks[0]!.periodStart,
        periodEnd: weeks[0]!.periodEnd,
        flowKind: "inflow",
        category: "ar_collection",
        amount: 1000,
        sourceKind: "ar_invoice",
        sourceId: "inv-1",
        label: "INV",
        explanation: "AR",
      },
      {
        weekIndex: 1,
        periodStart: weeks[0]!.periodStart,
        periodEnd: weeks[0]!.periodEnd,
        flowKind: "outflow",
        category: "payroll",
        amount: 2500.33,
        sourceKind: "payroll_posted",
        sourceId: "pr-1",
        label: "Payroll",
        explanation: "Payroll",
      },
      {
        weekIndex: 2,
        periodStart: weeks[1]!.periodStart,
        periodEnd: weeks[1]!.periodEnd,
        flowKind: "outflow",
        category: "recurring",
        amount: 500,
        sourceKind: "recurring_bill",
        sourceId: "tpl-1",
        label: "Rent",
        explanation: "Recurring",
      },
    ];
    const { weeks: weekRows, summary } = aggregateWeeklyCash({
      startingCash: 10000,
      horizonWeeks: weeks,
      flowLines,
    });
    expect(weekRows[0]!.closingCash).toBe(8499.67);
    expect(weekRows[1]!.openingCash).toBe(8499.67);
    expect(summary.firstNegativeWeekIndex).toBeNull();
  });

  it("builds source coverage from merged lines", () => {
    const coverage = buildSourceCoverage([
      {
        weekIndex: 1,
        periodStart: "2027-09-06",
        periodEnd: "2027-09-12",
        flowKind: "outflow",
        category: "payroll",
        amount: 100,
        sourceKind: "payroll_posted",
        sourceId: "p1",
        label: "Payroll",
        explanation: "Payroll",
      },
      {
        weekIndex: 1,
        periodStart: "2027-09-06",
        periodEnd: "2027-09-12",
        flowKind: "outflow",
        category: "purchasing",
        amount: 200,
        sourceKind: "po_line_commitment",
        sourceId: "po1",
        label: "PO",
        explanation: "PO",
      },
    ]);
    expect(coverage.find((row) => row.key === "payroll")?.count).toBe(1);
    expect(coverage.find((row) => row.key === "purchasing")?.count).toBe(1);
    expect(coverage.every((row) => row.included)).toBe(true);
  });

  it("surfaces incomplete source warnings", () => {
    const warnings = buildCashWarnings({
      startingCashAccounts: 1,
      arOverdueCount: 0,
      apOverdueCount: 0,
      arDefaultTimingCount: 0,
      apDefaultTimingCount: 0,
      firstNegativeWeekIndex: null,
      payrollMissingAmount: true,
      unscheduledPurchasingCount: 2,
      dedupeDroppedCount: 1,
    });
    expect(warnings.some((w) => w.code === "payroll_amount_unavailable")).toBe(true);
    expect(warnings.some((w) => w.code === "unscheduled_purchasing")).toBe(true);
    expect(warnings.some((w) => w.code === "source_dedupe")).toBe(true);
  });
});
