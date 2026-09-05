import { describe, expect, it } from "vitest";
import { canWriteBooks } from "@/lib/auth/roles";
import { assertBalanced, buildReversalLines } from "./post";

describe("journal balance", () => {
  it("accepts a balanced invoice posting", () => {
    expect(() =>
      assertBalanced([
        { account_id: "ar", debit: 1080 },
        { account_id: "rev", credit: 1000 },
        { account_id: "tax", credit: 80 },
      ]),
    ).not.toThrow();
  });

  it("rejects an unbalanced entry", () => {
    expect(() =>
      assertBalanced([
        { account_id: "ar", debit: 100 },
        { account_id: "rev", credit: 90 },
      ]),
    ).toThrow(/unbalanced/i);
  });
});

describe("buildReversalLines", () => {
  it("swaps debits and credits and keeps dimensions", () => {
    const reversed = buildReversalLines([
      {
        account_id: "cash",
        debit: 100,
        credit: 0,
        party_id: "party-1",
        job_id: null,
        memo: "Payment INV-001",
      },
      {
        account_id: "ar",
        debit: 0,
        credit: 100,
        party_id: "party-1",
        job_id: null,
        memo: "Payment INV-001",
      },
    ]);

    expect(reversed).toEqual([
      {
        account_id: "cash",
        debit: 0,
        credit: 100,
        party_id: "party-1",
        job_id: null,
        memo: "Reversal: Payment INV-001",
      },
      {
        account_id: "ar",
        debit: 100,
        credit: 0,
        party_id: "party-1",
        job_id: null,
        memo: "Reversal: Payment INV-001",
      },
    ]);
    expect(() => assertBalanced(reversed)).not.toThrow();
  });
});

describe("canWriteBooks", () => {
  it("allows owner, admin, and bookkeeper", () => {
    expect(canWriteBooks("owner")).toBe(true);
    expect(canWriteBooks("admin")).toBe(true);
    expect(canWriteBooks("bookkeeper")).toBe(true);
  });

  it("denies viewer and unknown roles", () => {
    expect(canWriteBooks("viewer")).toBe(false);
    expect(canWriteBooks(undefined)).toBe(false);
  });
});
