import { describe, expect, it } from "vitest";
import {
  classifyExpenseText,
  findMileageAccount,
  mileageAmount,
} from "./classify";

const ACCOUNTS = [
  { id: "a1", code: "6100", name: "Vehicle & Fuel" },
  { id: "a2", code: "6200", name: "Tools & Supplies" },
  { id: "a3", code: "6600", name: "Office" },
  { id: "a4", code: "6900", name: "Other Expense" },
];

describe("classifyExpenseText", () => {
  it("classifies fuel vendors to vehicle account", () => {
    const result = classifyExpenseText(ACCOUNTS, { vendorName: "Shell Gas Station" });
    expect(result.accountCode).toBe("6100");
    expect(result.confidence).toBe("medium");
  });

  it("classifies hardware stores to tools account", () => {
    const result = classifyExpenseText(ACCOUNTS, { vendorName: "Home Depot" });
    expect(result.accountCode).toBe("6200");
  });

  it("classifies Google Workspace as software", () => {
    const result = classifyExpenseText(ACCOUNTS, {
      vendorName: "Google",
      description: "Google Workspace Business Standard",
    });
    expect(result.accountCode).toBe("6100");
  });

  it("falls back to other expense", () => {
    const result = classifyExpenseText(ACCOUNTS, { vendorName: "Unknown Vendor XYZ" });
    expect(result.accountCode).toBe("6900");
    expect(result.confidence).toBe("low");
  });
});

describe("mileageAmount", () => {
  it("computes miles times rate", () => {
    expect(mileageAmount(100, 0.7)).toBe(70);
    expect(mileageAmount(12.5, 0.67)).toBe(8.38);
  });

  it("finds mileage account", () => {
    expect(findMileageAccount(ACCOUNTS)?.code).toBe("6100");
  });
});
