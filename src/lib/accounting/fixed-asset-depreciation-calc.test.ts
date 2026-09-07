import { describe, expect, it } from "vitest";
import { roundMoney } from "./payment-fees";
import {
  buildStraightLineSchedule,
  computeDepreciableBasis,
  firstDepreciationPeriod,
  isFullyDepreciated,
} from "./fixed-asset-depreciation-calc";

describe("fixed-asset-depreciation-calc", () => {
  it("derives depreciable basis from cost minus salvage", () => {
    expect(computeDepreciableBasis(10000, 1000)).toBe(9000);
    expect(computeDepreciableBasis(5000, 6000)).toBe(0);
  });

  it("uses full_month convention for first period", () => {
    expect(firstDepreciationPeriod("2026-03-15", "full_month")).toEqual({ year: 2026, month: 3 });
  });

  it("uses next_full_month convention for first period", () => {
    expect(firstDepreciationPeriod("2026-03-15", "next_full_month")).toEqual({ year: 2026, month: 4 });
  });

  it("last period absorbs rounding so total equals basis", () => {
    const schedule = buildStraightLineSchedule({
      originalCost: 10000,
      salvageValue: 0,
      usefulLifeMonths: 36,
      placedInServiceDate: "2026-01-01",
      convention: "full_month",
    });
    const total = roundMoney(schedule.reduce((sum, line) => sum + line.depreciationAmount, 0));
    expect(total).toBe(10000);
    expect(schedule.at(-1)?.isFinalPeriod).toBe(true);
  });

  it("detects fully depreciated from posted accum", () => {
    expect(isFullyDepreciated(10000, 1000, 9000)).toBe(true);
    expect(isFullyDepreciated(10000, 1000, 8000)).toBe(false);
  });
});
