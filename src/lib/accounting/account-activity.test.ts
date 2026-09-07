import { describe, expect, it } from "vitest";
import { buildAccountActivityReport } from "./account-activity";

const ACCOUNT = {
  id: "cash",
  code: "1000",
  name: "Cash",
  type: "asset",
};

describe("buildAccountActivityReport", () => {
  it("computes opening balance and running totals", () => {
    const report = buildAccountActivityReport({
      account: ACCOUNT,
      entries: [
        { id: "e1", entry_date: "2026-02-01", memo: "Prior", source_kind: null, source_id: null, reverses_entry_id: null },
        { id: "e2", entry_date: "2026-03-05", memo: "In period", source_kind: "manual", source_id: null, reverses_entry_id: null },
      ],
      lines: [
        { id: "l1", entry_id: "e1", account_id: "cash", debit: 100, credit: 0 },
        { id: "l2", entry_id: "e2", account_id: "cash", debit: 50, credit: 0 },
      ],
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });

    expect(report.openingBalance).toBe(100);
    expect(report.closingBalance).toBe(150);
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]?.runningBalance).toBe(150);
    expect(report.lines[0]?.source.kind).toBe("manual");
  });
});
