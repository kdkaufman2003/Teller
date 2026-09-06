import { describe, expect, it } from "vitest";
import {
  bestSuggestionV2,
  confidenceTierFromScore,
  matchAmountForTransaction,
  suggestBankTransactionMatchesV2,
} from "./match-v2";

describe("suggestBankTransactionMatchesV2", () => {
  it("suggests exact customer payment matches for inflows", () => {
    const suggestions = suggestBankTransactionMatchesV2(
      {
        id: "txn-1",
        bank_account_id: "bank-1",
        posted_date: "2026-05-01",
        normalized_amount: 1500,
        description: "Stripe deposit ABC Heating",
      },
      {
        payments: [
          {
            id: "pay-1",
            payment_type: "customer_payment",
            amount: 1500,
            payment_date: "2026-05-01",
            party_name: "ABC Heating",
            reference_number: "STRIPE-001",
          },
        ],
        journalEntries: [],
      },
    );

    expect(suggestions[0]).toMatchObject({
      resourceType: "customer_payment",
      resourceId: "pay-1",
      confidenceTier: "exact",
    });
    expect(suggestions[0].confidence).toBeGreaterThan(0.85);
  });

  it("suggests bill payments for outflows", () => {
    const suggestions = suggestBankTransactionMatchesV2(
      {
        id: "txn-2",
        bank_account_id: "bank-1",
        posted_date: "2026-05-02",
        normalized_amount: -428.16,
        description: "Home Depot",
      },
      {
        payments: [
          {
            id: "pay-2",
            payment_type: "bill_payment",
            amount: 428.16,
            payment_date: "2026-05-02",
            party_name: "Home Depot",
          },
        ],
        journalEntries: [],
      },
    );

    expect(suggestions[0]?.resourceType).toBe("bill_payment");
  });

  it("suggests journal entries on bank GL lines", () => {
    const suggestions = suggestBankTransactionMatchesV2(
      {
        id: "txn-3",
        bank_account_id: "bank-1",
        posted_date: "2026-05-03",
        normalized_amount: 250,
        description: "Manual deposit",
      },
      {
        payments: [],
        journalEntries: [
          {
            id: "je-1",
            entry_date: "2026-05-03",
            memo: "Manual deposit",
            bank_line_amount: 250,
          },
        ],
      },
    );

    expect(suggestions[0]?.resourceType).toBe("journal_entry");
  });

  it("respects already matched payment totals", () => {
    const suggestions = suggestBankTransactionMatchesV2(
      {
        id: "txn-4",
        bank_account_id: "bank-1",
        posted_date: "2026-05-04",
        normalized_amount: 500,
        description: "Payment",
      },
      {
        payments: [
          {
            id: "pay-3",
            payment_type: "customer_payment",
            amount: 500,
            payment_date: "2026-05-04",
            matched_total: 500,
          },
        ],
        journalEntries: [],
      },
    );

    expect(suggestions).toHaveLength(0);
  });
});

describe("bestSuggestionV2", () => {
  it("returns high-confidence suggestions", () => {
    const suggestion = bestSuggestionV2([
      {
        resourceType: "customer_payment",
        resourceId: "pay-1",
        label: "Payment",
        amount: 100,
        date: "2026-05-01",
        confidence: 0.9,
        confidenceTier: "high",
        reason: "test",
      },
    ]);
    expect(suggestion?.resourceId).toBe("pay-1");
  });

  it("returns null for low-confidence suggestions", () => {
    expect(
      bestSuggestionV2([
        {
          resourceType: "customer_payment",
          resourceId: "pay-1",
          label: "Weak",
          amount: 10,
          date: "2026-01-01",
          confidence: 0.5,
          confidenceTier: "low",
          reason: "test",
        },
      ]),
    ).toBeNull();
  });
});

describe("confidenceTierFromScore", () => {
  it("maps score thresholds to tiers", () => {
    expect(confidenceTierFromScore(0.96, true)).toBe("exact");
    expect(confidenceTierFromScore(0.88, false)).toBe("high");
    expect(confidenceTierFromScore(0.7, false)).toBe("medium");
    expect(confidenceTierFromScore(0.4, false)).toBe("low");
  });
});

describe("matchAmountForTransaction", () => {
  it("uses absolute normalized amount by default", () => {
    expect(
      matchAmountForTransaction({
        id: "txn-1",
        bank_account_id: "bank-1",
        posted_date: "2026-05-01",
        normalized_amount: -87.42,
      }),
    ).toBe(87.42);
  });
});
