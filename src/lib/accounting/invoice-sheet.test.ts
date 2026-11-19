import { describe, expect, it } from "vitest";
import { parseInvoiceSheet } from "./invoice-sheet";

const VERCEL_SHEET = `
Upcoming Invoice Upcoming
November 18 - December 18
Estimated Total $20.00

October 2026 Paid
Infrastructure usage & Vercel platform
Total Due $20.00
Invoiced Oct 18, 2026

September 2026 Paid
Domain Registration
Total Due $11.25
Invoiced Sep 20, 2026

May 2026 Paid
3DTLBILH-0003
Total Due $0.00
Invoiced May 18, 2026

May 2026 Paid
Pro
Total Due $20.00
Invoiced May 18, 2026
`;

describe("parseInvoiceSheet", () => {
  it("reads a billing-history sheet into vendor invoice rows", () => {
    const rows = parseInvoiceSheet(VERCEL_SHEET);
    expect(rows.map((row) => [row.period, row.description, row.amount, row.issueDate, row.status, row.include])).toEqual([
      ["Upcoming invoice", "November 18 - December 18", 20, "2026-11-18", "upcoming", true],
      ["October 2026", "Infrastructure usage & Vercel platform", 20, "2026-10-18", "paid", true],
      ["September 2026", "Domain Registration", 11.25, "2026-09-20", "paid", true],
      ["May 2026", "3DTLBILH-0003", 0, "2026-05-18", "paid", false],
      ["May 2026", "Pro", 20, "2026-05-18", "paid", true],
    ]);
  });

  it("reads a csv with headers", () => {
    const rows = parseInvoiceSheet(`period,status,description,amount,date
October 2026,Paid,Infrastructure usage & Vercel platform,"$20.00",2026-10-18
September 2026,Paid,Domain Registration,11.25,2026-09-20`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      period: "October 2026",
      description: "Infrastructure usage & Vercel platform",
      amount: 20,
      issueDate: "2026-10-18",
      status: "paid",
      include: true,
    });
    expect(rows[1].amount).toBe(11.25);
  });

  it("reads a headerless csv row", () => {
    const rows = parseInvoiceSheet(
      "October 2026,Paid,Infrastructure usage & Vercel platform,20.00,2026-10-18",
    );
    expect(rows[0]).toMatchObject({
      description: "Infrastructure usage & Vercel platform",
      amount: 20,
      status: "paid",
      issueDate: "2026-10-18",
    });
  });
});
