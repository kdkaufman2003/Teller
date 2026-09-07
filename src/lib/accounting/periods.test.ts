import { describe, expect, it } from "vitest";
import {
  assertEntryDateOpen,
  booksClosedThrough,
  nextCloseablePeriodEnd,
  PeriodClosedError,
  recentMonthPeriods,
  validatePeriodClose,
} from "./periods";

describe("booksClosedThrough", () => {
  it("returns effective closed-through from the latest event", () => {
    expect(
      booksClosedThrough([
        { period_end: "2026-01-31", effective_closed_through: "2026-01-31", closed_at: "2026-02-01T00:00:00Z" },
        { period_end: "2026-03-31", effective_closed_through: "2026-03-31", closed_at: "2026-04-01T00:00:00Z" },
        { period_end: "2026-03-31", effective_closed_through: "2026-02-28", closed_at: "2026-04-02T00:00:00Z" },
      ]),
    ).toBe("2026-02-28");
  });

  it("falls back to period_end when effective_closed_through is absent", () => {
    expect(
      booksClosedThrough([{ period_end: "2026-03-31", closed_at: "2026-04-01T00:00:00Z" }]),
    ).toBe("2026-03-31");
  });

  it("treats reopen events with null effective as open", () => {
    expect(
      booksClosedThrough([
        { period_end: "2026-08-31", effective_closed_through: "2026-08-31", closed_at: "2026-09-01T00:00:00Z", event_type: "close" },
        { period_end: "2026-08-31", effective_closed_through: null, closed_at: "2026-09-02T00:00:00Z", event_type: "reopen" },
      ]),
    ).toBeNull();
  });
});

describe("assertEntryDateOpen", () => {
  it("allows dates after the close", () => {
    expect(() => assertEntryDateOpen("2026-03-31", "2026-04-01")).not.toThrow();
  });

  it("blocks dates on or before the close", () => {
    expect(() => assertEntryDateOpen("2026-03-31", "2026-03-31")).toThrow(PeriodClosedError);
    expect(() => assertEntryDateOpen("2026-03-31", "2026-02-15")).toThrow(/closed through/i);
  });
});

describe("validatePeriodClose", () => {
  it("requires sequential closes", () => {
    expect(
      validatePeriodClose({
        periodEnd: "2026-03-31",
        closedThrough: "2026-01-31",
        today: "2026-04-15",
      }),
    ).toEqual({
      ok: false,
      reason: "Close periods in order. Next period to close ends 2026-02-28.",
    });
  });

  it("accepts the next closeable month", () => {
    expect(
      validatePeriodClose({
        periodEnd: "2026-02-28",
        closedThrough: "2026-01-31",
        today: "2026-04-15",
      }),
    ).toEqual({ ok: true });
  });
});

describe("nextCloseablePeriodEnd", () => {
  it("defaults to the previous month when nothing is closed", () => {
    expect(nextCloseablePeriodEnd(null, "2026-04-15")).toBe("2026-03-31");
  });
});

describe("recentMonthPeriods", () => {
  it("marks closed months", () => {
    const periods = recentMonthPeriods(3, new Date("2026-04-15T12:00:00"), "2026-02-28");
    expect(periods[0]?.status).toBe("open");
    expect(periods[2]?.status).toBe("closed");
  });
});
