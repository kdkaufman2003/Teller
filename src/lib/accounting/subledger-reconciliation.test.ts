import { describe, expect, it } from "vitest";
import {
  computePartyNetApBalance,
  computePartyNetArBalance,
  sumPartyNetApBalances,
  sumPartyNetArBalances,
} from "./party-balances";

describe("computePartyNetArBalance", () => {
  it("unapplied credit: invoice 10,000 + credit 1,000 unapplied = customer AR 9,000", () => {
    expect(computePartyNetArBalance(10000, 1000)).toBe(9000);
  });

  it("partial application: invoice 9,000 + credit remaining 2,000 = customer AR 7,000", () => {
    expect(computePartyNetArBalance(9000, 2000)).toBe(7000);
  });

  it("full application: invoice 7,000 + credit remaining 0 = customer AR 7,000", () => {
    expect(computePartyNetArBalance(7000, 0)).toBe(7000);
  });

  it("does not double-count applied credits already in invoice remaining", () => {
    // Invoice was 10,000; 1,000 credit applied → invoice remaining 9,000
    // Credit memo 3,000 with 1,000 applied → unapplied 2,000
    expect(computePartyNetArBalance(9000, 2000)).toBe(7000);
  });
});

describe("computePartyNetApBalance", () => {
  it("unapplied vendor credit: bill 5,000 + credit 500 unapplied = vendor AP 4,500", () => {
    expect(computePartyNetApBalance(5000, 500)).toBe(4500);
  });

  it("partial vendor credit application: bill 4,500 + credit remaining 200 = AP 4,300", () => {
    expect(computePartyNetApBalance(4500, 200)).toBe(4300);
  });

  it("fully applied vendor credit: bill 4,500 + credit remaining 0 = AP 4,500", () => {
    expect(computePartyNetApBalance(4500, 0)).toBe(4500);
  });
});

describe("organization net subledger from party totals", () => {
  it("sums customer net AR across parties", () => {
    const parties = [
      { partyId: "a", invoiceRemaining: 10000, unappliedCredits: 1000, netAr: 9000 },
      { partyId: "b", invoiceRemaining: 5000, unappliedCredits: 0, netAr: 5000 },
    ];
    expect(sumPartyNetArBalances(parties)).toBe(14000);
    expect(10000 - 1000 + 5000).toBe(14000);
  });

  it("sums vendor net AP across parties", () => {
    const parties = [
      { partyId: "v1", billRemaining: 5000, unappliedVendorCredits: 500, netAp: 4500 },
      { partyId: "v2", billRemaining: 2000, unappliedVendorCredits: 0, netAp: 2000 },
    ];
    expect(sumPartyNetApBalances(parties)).toBe(6500);
  });
});

describe("reconciliation formula invariants", () => {
  it("org net AR equals invoice remaining sum minus unapplied credit sum", () => {
    const invoiceRemainingTotal = 19000;
    const unappliedCreditTotal = 3000;
    const netSubledger = invoiceRemainingTotal - unappliedCreditTotal;
    expect(netSubledger).toBe(16000);
    expect(computePartyNetArBalance(10000, 1000) + computePartyNetArBalance(9000, 2000)).toBe(
      16000,
    );
  });

  it("applied credits reduce invoice remaining only once", () => {
    const invoiceRemainingAfterAppliedCredit = 9000;
    const creditUnappliedAfterPartialApply = 2000;
    const customerAr = computePartyNetArBalance(
      invoiceRemainingAfterAppliedCredit,
      creditUnappliedAfterPartialApply,
    );
    expect(customerAr).toBe(7000);
    // GL AR must match — not 9000 (invoice only) and not 7000 - 1000 (double subtract)
  });
});
