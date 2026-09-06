import { describe, expect, it } from "vitest";
import {
  directionFromNormalizedAmount,
  inferBankGlKind,
  legacyMatchStatusToStatus,
  normalizeProviderAmount,
  statusToLegacyMatchStatus,
} from "./normalize";

describe("bank amount normalization", () => {
  it("normalizes Plaid asset inflow (negative raw) to positive Teller amount", () => {
    expect(normalizeProviderAmount(-1000, "asset_bank")).toBe(1000);
    expect(directionFromNormalizedAmount(1000, "asset_bank")).toBe("inflow");
  });

  it("normalizes Plaid asset outflow (positive raw) to negative Teller amount", () => {
    expect(normalizeProviderAmount(500, "asset_bank")).toBe(-500);
    expect(directionFromNormalizedAmount(-500, "asset_bank")).toBe("outflow");
  });

  it("preserves credit card charge sign (positive liability increase)", () => {
    expect(normalizeProviderAmount(500, "credit_card_liability")).toBe(500);
    expect(directionFromNormalizedAmount(500, "credit_card_liability")).toBe("charge");
  });

  it("normalizes credit card payment/refund as liability decrease", () => {
    expect(normalizeProviderAmount(-500, "credit_card_liability")).toBe(-500);
    expect(directionFromNormalizedAmount(-500, "credit_card_liability")).toBe("payment");
  });

  it("infers credit card from GL liability type", () => {
    expect(
      inferBankGlKind({
        glAccountType: "liability",
        glAccountSubtype: "credit_card",
        bankAccountType: "depository",
      }),
    ).toBe("credit_card_liability");
  });

  it("infers asset bank from GL asset type", () => {
    expect(
      inferBankGlKind({
        glAccountType: "asset",
        glAccountSubtype: "bank",
      }),
    ).toBe("asset_bank");
  });
});

describe("legacy status compatibility", () => {
  it("maps legacy match_status to workflow status", () => {
    expect(legacyMatchStatusToStatus("unmatched")).toBe("unreviewed");
    expect(legacyMatchStatusToStatus("ignored")).toBe("excluded");
    expect(legacyMatchStatusToStatus("matched")).toBe("matched");
  });

  it("maps workflow status back for legacy APIs", () => {
    expect(statusToLegacyMatchStatus("partially_matched")).toBe("suggested");
    expect(statusToLegacyMatchStatus("categorized")).toBe("matched");
    expect(statusToLegacyMatchStatus("reconciled")).toBe("matched");
    expect(statusToLegacyMatchStatus("excluded")).toBe("ignored");
  });
});
