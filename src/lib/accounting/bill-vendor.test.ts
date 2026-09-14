import { describe, expect, it } from "vitest";
import { assertBillVendorChangeAllowed, assertPayableVendorChangeAllowed } from "./bill-vendor";

const base = {
  status: "open",
  currentPartyId: "vendor-numeric",
  nextPartyId: "vendor-google",
  hasActiveVendorCredits: false,
  vendorExists: true,
  vendorKind: "vendor",
};

describe("assertBillVendorChangeAllowed", () => {
  it("allows reassigning an open bill to another vendor", () => {
    expect(() => assertBillVendorChangeAllowed(base)).not.toThrow();
  });

  it("allows draft and pending approval bills", () => {
    expect(() => assertBillVendorChangeAllowed({ ...base, status: "draft" })).not.toThrow();
    expect(() =>
      assertBillVendorChangeAllowed({ ...base, status: "pending_approval" }),
    ).not.toThrow();
  });

  it("allows paid bills so history can be corrected", () => {
    expect(() => assertBillVendorChangeAllowed({ ...base, status: "paid" })).not.toThrow();
  });

  it("blocks void bills", () => {
    expect(() => assertBillVendorChangeAllowed({ ...base, status: "void" })).toThrow(
      /void bill/i,
    );
  });

  it("blocks the same vendor", () => {
    expect(() =>
      assertBillVendorChangeAllowed({ ...base, nextPartyId: "vendor-numeric" }),
    ).toThrow(/already assigned/i);
  });

  it("requires a vendor", () => {
    expect(() => assertBillVendorChangeAllowed({ ...base, nextPartyId: "  " })).toThrow(
      /required/i,
    );
  });

  it("rejects missing or non-vendor parties", () => {
    expect(() => assertBillVendorChangeAllowed({ ...base, vendorExists: false })).toThrow(
      /not found/i,
    );
    expect(() => assertBillVendorChangeAllowed({ ...base, vendorKind: "customer" })).toThrow(
      /not a vendor/i,
    );
  });

  it("allows parties marked as both customer and vendor", () => {
    expect(() => assertBillVendorChangeAllowed({ ...base, vendorKind: "both" })).not.toThrow();
  });

  it("blocks change while vendor credits are applied", () => {
    expect(() =>
      assertBillVendorChangeAllowed({ ...base, hasActiveVendorCredits: true }),
    ).toThrow(/credits are applied/i);
  });

  it("allows paid expenses so receipt vendors can be corrected", () => {
    expect(() =>
      assertPayableVendorChangeAllowed({ ...base, kind: "expense", status: "paid" }),
    ).not.toThrow();
  });

  it("blocks void expenses", () => {
    expect(() =>
      assertPayableVendorChangeAllowed({ ...base, kind: "expense", status: "void" }),
    ).toThrow(/void expense/i);
  });
});
