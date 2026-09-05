import { describe, expect, it } from "vitest";
import { bestSuggestion, suggestBankTransactionMatches } from "./match";

describe("suggestBankTransactionMatches", () => {
  it("suggests invoice payments for bank deposits", () => {
    const suggestions = suggestBankTransactionMatches(
      {
        id: "txn-1",
        amount: -1500,
        posted_date: "2026-03-01",
        name: "Stripe deposit",
      },
      {
        invoices: [
          {
            id: "inv-1",
            number: "INV-1001",
            total: 1500,
            amount_paid: 1500,
            issue_date: "2026-03-01",
            status: "paid",
          },
        ],
        expenses: [],
        journalDeposits: [],
      },
    );

    expect(suggestions[0]).toMatchObject({
      kind: "invoice_payment",
      resourceId: "inv-1",
      confidence: expect.any(Number),
    });
    expect(suggestions[0].confidence).toBeGreaterThan(0.7);
  });

  it("suggests expenses for bank outflows", () => {
    const suggestions = suggestBankTransactionMatches(
      {
        id: "txn-2",
        amount: 428.16,
        posted_date: "2026-03-02",
        name: "Home Depot",
      },
      {
        invoices: [],
        expenses: [
          {
            id: "exp-1",
            number: "EXP-1001",
            total: 428.16,
            issue_date: "2026-03-02",
            memo: "Materials",
          },
        ],
        journalDeposits: [],
      },
    );

    expect(suggestions[0]?.kind).toBe("expense");
  });
});

describe("bestSuggestion", () => {
  it("returns null when confidence is below threshold", () => {
    expect(
      bestSuggestion([
        {
          kind: "expense",
          resourceId: "exp-1",
          label: "Weak match",
          amount: 10,
          date: "2026-01-01",
          confidence: 0.6,
          reason: "test",
        },
      ]),
    ).toBeNull();
  });
});
