import { describe, expect, it } from "vitest";
import { determineInvoiceTaxFlat } from "./determine";

describe("determineInvoiceTaxFlat", () => {
  it("calculates organization flat rate tax", () => {
    const result = determineInvoiceTaxFlat({
      taxRatePercent: 8.975,
      lines: [
        { lineKey: "0", description: "Line", amount: 100, itemType: "equipment" },
      ],
    });

    expect(result.mode).toBe("flat");
    expect(result.tax).toBe(8.98);
    expect(result.lines[0].explanation.engine).toBe("flat_fallback");
  });
});
