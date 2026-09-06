import { describe, expect, it } from "vitest";
import { billRequiresApproval, poRequiresApproval } from "./ap-settings";
import { billStatusAfterPayment } from "./document-transitions";

describe("ap-settings approval thresholds", () => {
  it("requires approval when enabled without threshold", () => {
    expect(billRequiresApproval({ requireBillApproval: true, billApprovalThreshold: null, requirePoApproval: false, poApprovalThreshold: null, defaultCostCategories: [] }, 100)).toBe(true);
  });

  it("requires approval only above threshold", () => {
    const settings = {
      requireBillApproval: true,
      billApprovalThreshold: 500,
      requirePoApproval: false,
      poApprovalThreshold: null,
      defaultCostCategories: [],
    };
    expect(billRequiresApproval(settings, 400)).toBe(false);
    expect(billRequiresApproval(settings, 600)).toBe(true);
  });

  it("evaluates PO approval independently", () => {
    expect(
      poRequiresApproval(
        {
          requireBillApproval: false,
          billApprovalThreshold: null,
          requirePoApproval: true,
          poApprovalThreshold: 1000,
          defaultCostCategories: [],
        },
        1500,
      ),
    ).toBe(true);
  });
});

describe("bill partial payments", () => {
  it("tracks partially paid then paid", () => {
    expect(billStatusAfterPayment(1000, 400)).toBe("partially_paid");
    expect(billStatusAfterPayment(1000, 1000)).toBe("paid");
  });
});
