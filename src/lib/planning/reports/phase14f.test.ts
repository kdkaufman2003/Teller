import { describe, expect, it } from "vitest";
import { projectArCollections, type OpenReceivable } from "@/lib/planning/cash/ar-adapter";
import { projectApPayments, type OpenPayable } from "@/lib/planning/cash/ap-adapter";
import {
  aggregateWeeklyCash,
  buildCashWarnings,
  manualOverridesToFlowLines,
} from "@/lib/planning/cash/engine";
import { isEligibleCashAccount } from "@/lib/planning/cash/starting-cash";
import { resolveArCollectionDate, resolveApPaymentDate } from "@/lib/planning/cash/timing";
import {
  bucketDateIntoHorizon,
  buildCashHorizonWeeks,
  weekStartMonday,
} from "@/lib/planning/cash/weeks";

describe("Phase 14F week horizon", () => {
  it("builds 13 Monday–Sunday weeks", () => {
    const { weeks, horizonStart } = buildCashHorizonWeeks("2027-09-08", 13);
    expect(weeks).toHaveLength(13);
    expect(horizonStart).toBe(weekStartMonday("2027-09-08"));
    expect(weeks[0]!.weekIndex).toBe(1);
    expect(weeks[12]!.weekIndex).toBe(13);
  });

  it("buckets overdue dates into overdue kind", () => {
    const { weeks, horizonStart, horizonEnd } = buildCashHorizonWeeks("2027-09-08", 13);
    const bucket = bucketDateIntoHorizon("2027-08-01", horizonStart, horizonEnd, weeks);
    expect(bucket.kind).toBe("overdue");
  });

  it("buckets beyond horizon separately", () => {
    const { weeks, horizonStart, horizonEnd } = buildCashHorizonWeeks("2027-09-08", 13);
    const bucket = bucketDateIntoHorizon("2028-01-15", horizonStart, horizonEnd, weeks);
    expect(bucket.kind).toBe("beyond");
  });

  it("places in-week dates in correct week index", () => {
    const { weeks, horizonStart, horizonEnd } = buildCashHorizonWeeks("2027-09-08", 13);
    const target = weeks[2]!.periodStart;
    const bucket = bucketDateIntoHorizon(target, horizonStart, horizonEnd, weeks);
    expect(bucket).toEqual({ kind: "week", weekIndex: 3 });
  });
});

describe("Phase 14F timing", () => {
  it("prefers due date over defaults for AR", () => {
    const result = resolveArCollectionDate({
      issueDate: "2027-01-01",
      dueDate: "2027-02-15",
      partyId: null,
      defaultArDays: 30,
      partyOverrides: new Map(),
    });
    expect(result.date).toBe("2027-02-15");
    expect(result.usedDefault).toBe(false);
  });

  it("uses default AR days when due date missing", () => {
    const result = resolveArCollectionDate({
      issueDate: "2027-01-01",
      dueDate: null,
      partyId: null,
      defaultArDays: 30,
      partyOverrides: new Map(),
    });
    expect(result.date).toBe("2027-01-31");
    expect(result.usedDefault).toBe(true);
  });

  it("uses party override for AP when due date missing", () => {
    const overrides = new Map([["party-1", { paymentDays: 15 }]]);
    const result = resolveApPaymentDate({
      issueDate: "2027-03-01",
      dueDate: null,
      partyId: "party-1",
      defaultApDays: 30,
      partyOverrides: overrides,
    });
    expect(result.date).toBe("2027-03-16");
    expect(result.usedPartyOverride).toBe(true);
  });
});

describe("Phase 14F AR/AP projection", () => {
  const { weeks, horizonStart, horizonEnd } = buildCashHorizonWeeks("2027-09-08", 13);

  it("projects AR by due date into week bucket", () => {
    const receivables: OpenReceivable[] = [
      {
        documentId: "inv-1",
        number: "1042",
        partyId: null,
        partyName: "Acme",
        issueDate: "2027-08-01",
        dueDate: weeks[1]!.periodStart,
        remainingBalance: 12500,
      },
    ];
    const { lines } = projectArCollections({
      receivables,
      horizonWeeks: weeks,
      horizonStart,
      horizonEnd,
      defaultArDays: 30,
      partyOverrides: new Map(),
    });
    expect(lines[0]!.weekIndex).toBe(2);
    expect(lines[0]!.amount).toBe(12500);
  });

  it("rolls overdue AR into week 1", () => {
    const receivables: OpenReceivable[] = [
      {
        documentId: "inv-2",
        number: "99",
        partyId: null,
        partyName: "Late Co",
        issueDate: "2027-01-01",
        dueDate: "2027-06-01",
        remainingBalance: 500,
      },
    ];
    const { lines, overdueCount } = projectArCollections({
      receivables,
      horizonWeeks: weeks,
      horizonStart,
      horizonEnd,
      defaultArDays: 30,
      partyOverrides: new Map(),
    });
    expect(lines[0]!.weekIndex).toBe(1);
    expect(lines[0]!.overdue).toBe(true);
    expect(overdueCount).toBe(1);
  });

  it("uses remaining balance not original total (partial payment scenario)", () => {
    const receivables: OpenReceivable[] = [
      {
        documentId: "inv-3",
        number: "55",
        partyId: null,
        partyName: "Partial",
        issueDate: "2027-08-01",
        dueDate: weeks[0]!.periodStart,
        remainingBalance: 2500.55,
      },
    ];
    const { lines } = projectArCollections({
      receivables,
      horizonWeeks: weeks,
      horizonStart,
      horizonEnd,
      defaultArDays: 30,
      partyOverrides: new Map(),
    });
    expect(lines[0]!.amount).toBe(2500.55);
  });

  it("projects AP overdue into week 1", () => {
    const payables: OpenPayable[] = [
      {
        documentId: "bill-1",
        number: "9342",
        kind: "bill",
        partyId: null,
        partyName: "Vendor",
        issueDate: "2027-01-01",
        dueDate: "2027-05-01",
        remainingBalance: 4800,
      },
    ];
    const { lines, overdueCount } = projectApPayments({
      payables,
      horizonWeeks: weeks,
      horizonStart,
      horizonEnd,
      defaultApDays: 30,
      partyOverrides: new Map(),
    });
    expect(lines[0]!.weekIndex).toBe(1);
    expect(lines[0]!.overdue).toBe(true);
    expect(overdueCount).toBe(1);
  });

  it("excludes beyond-horizon AP from weekly buckets", () => {
    const payables: OpenPayable[] = [
      {
        documentId: "bill-2",
        number: "999",
        kind: "bill",
        partyId: null,
        partyName: "Future",
        issueDate: "2027-09-01",
        dueDate: "2028-06-01",
        remainingBalance: 100,
      },
    ];
    const { lines } = projectApPayments({
      payables,
      horizonWeeks: weeks,
      horizonStart,
      horizonEnd,
      defaultApDays: 30,
      partyOverrides: new Map(),
    });
    expect(lines[0]!.beyondHorizon).toBe(true);
    expect(lines[0]!.weekIndex).toBeNull();
  });
});

describe("Phase 14F weekly roll-forward", () => {
  const { weeks } = buildCashHorizonWeeks("2027-09-08", 13);

  it("rolls opening/closing cash with exact cents", () => {
    const flowLines = manualOverridesToFlowLines({
      overrides: [
        {
          id: "m1",
          effectiveDate: weeks[0]!.periodStart,
          flowKind: "inflow",
          amount: 1000.33,
          label: "Deposit",
          notes: "",
        },
        {
          id: "m2",
          effectiveDate: weeks[1]!.periodStart,
          flowKind: "outflow",
          amount: 400.11,
          label: "Insurance",
          notes: "",
        },
      ],
      horizonWeeks: weeks,
      horizonStart: weeks[0]!.periodStart,
      horizonEnd: weeks[12]!.periodEnd,
    });

    const { weeks: weekRows, summary: totals } = aggregateWeeklyCash({
      startingCash: 5000,
      horizonWeeks: weeks,
      flowLines,
    });

    expect(weekRows[0]!.openingCash).toBe(5000);
    expect(weekRows[0]!.closingCash).toBe(6000.33);
    expect(weekRows[1]!.openingCash).toBe(6000.33);
    expect(weekRows[1]!.closingCash).toBe(5600.22);
    expect(totals.expectedMoneyIn).toBe(1000.33);
    expect(totals.expectedMoneyOut).toBe(400.11);
  });

  it("detects first negative week and lowest cash", () => {
    const { weeks: horizon } = buildCashHorizonWeeks("2027-09-08", 13);
    const flowLines = manualOverridesToFlowLines({
      overrides: [
        {
          id: "big-out",
          effectiveDate: horizon[2]!.periodStart,
          flowKind: "outflow",
          amount: 15000,
          label: "Tax",
          notes: "",
        },
      ],
      horizonWeeks: horizon,
      horizonStart: horizon[0]!.periodStart,
      horizonEnd: horizon[12]!.periodEnd,
    });

    const { summary } = aggregateWeeklyCash({
      startingCash: 10000,
      horizonWeeks: horizon,
      flowLines,
    });

    expect(summary.firstNegativeWeekIndex).toBe(3);
    expect(summary.runwayWeeks).toBe(3);
    expect(summary.lowestCash).toBeLessThan(0);
  });

  it("reports 13+ week runway when never negative", () => {
    const { summary } = aggregateWeeklyCash({
      startingCash: 50000,
      horizonWeeks: weeks,
      flowLines: [],
    });
    expect(summary.runwayWeeks).toBe("13+");
    expect(summary.firstNegativeWeekIndex).toBeNull();
  });
});

describe("Phase 14F cash accounts", () => {
  it("includes bank subtype and excludes AR", () => {
    expect(isEligibleCashAccount({ id: "1", code: "1000", name: "Cash", type: "asset", subtype: "bank" })).toBe(true);
    expect(isEligibleCashAccount({ id: "2", code: "1100", name: "AR", type: "asset", subtype: "receivable" })).toBe(false);
    expect(isEligibleCashAccount({ id: "3", code: "1010", name: "Savings", type: "asset", subtype: "bank" })).toBe(true);
  });
});

describe("Phase 14F warnings", () => {
  it("includes no shortfall when cash stays positive", () => {
    const warnings = buildCashWarnings({
      startingCashAccounts: 1,
      arOverdueCount: 0,
      apOverdueCount: 0,
      arDefaultTimingCount: 0,
      apDefaultTimingCount: 0,
      firstNegativeWeekIndex: null,
    });
    expect(warnings.some((w) => w.code === "no_shortfall")).toBe(true);
  });
});
