import { describe, expect, it } from "vitest";
import {
  buildJournalCsv,
  buildPartiesCsv,
  buildTrialBalanceCsv,
  escapeCsvValue,
  summarizeTrialBalance,
} from "./exports";

describe("escapeCsvValue", () => {
  it("quotes values with commas", () => {
    expect(escapeCsvValue('Acme, LLC')).toBe('"Acme, LLC"');
  });
});

describe("buildJournalCsv", () => {
  it("renders a header row and journal lines", () => {
    const csv = buildJournalCsv([
      {
        entry_date: "2026-03-01",
        memo: "Invoice payment",
        source_kind: "invoice",
        account_code: "1000",
        account_name: "Cash",
        debit: 100,
        credit: 0,
        line_memo: "",
      },
    ]);

    expect(csv.split("\n")[0]).toContain("Entry Date");
    expect(csv).toContain("Invoice payment");
    expect(csv).toContain("1000");
  });
});

describe("summarizeTrialBalance", () => {
  it("aggregates debits and credits by account", () => {
    const rows = summarizeTrialBalance(
      [
        { account_id: "cash", debit: 100, credit: 0 },
        { account_id: "cash", debit: 50, credit: 25 },
      ],
      [{ id: "cash", code: "1000", name: "Cash", type: "asset" }],
    );

    expect(rows).toEqual([
      {
        code: "1000",
        name: "Cash",
        type: "asset",
        debit: 150,
        credit: 25,
        net: 125,
      },
    ]);
  });
});

describe("buildPartiesCsv", () => {
  it("exports customer rows", () => {
    const csv = buildPartiesCsv([
      { name: "ABC Mechanical", kind: "customer", email: "ops@abc.com", phone: "555-0100" },
    ]);
    expect(csv).toContain("ABC Mechanical");
    expect(buildTrialBalanceCsv([])).toContain("Account Code");
  });
});
