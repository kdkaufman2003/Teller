import { describe, expect, it } from "vitest";
import {
  extractDescriptionFromReceiptText,
  extractTotalFromReceiptText,
  extractVendorFromReceiptText,
  parseReceiptAmount,
  vendorFromFileName,
} from "./receipt-analyze";

describe("parseReceiptAmount", () => {
  it("parses currency strings", () => {
    expect(parseReceiptAmount("$1,234.56")).toBe(1234.56);
    expect(parseReceiptAmount(42.5)).toBe(42.5);
  });
});

describe("extractTotalFromReceiptText", () => {
  it("prefers labeled total lines", () => {
    const text = `
      Home Depot
      Drill bits
      Subtotal $40.00
      Tax $3.20
      TOTAL $43.20
    `;
    expect(extractTotalFromReceiptText(text)).toBe(43.2);
  });

  it("finds amount paid", () => {
    const text = "Shell Oil\nFuel\nAmount Paid: $52.18";
    expect(extractTotalFromReceiptText(text)).toBe(52.18);
  });
});

describe("extractVendorFromReceiptText", () => {
  it("returns an early merchant line", () => {
    const text = "Home Depot #1234\n123 Main St\nReceipt\nTOTAL $10.00";
    expect(extractVendorFromReceiptText(text)).toBe("Home Depot #1234");
  });
});

describe("extractDescriptionFromReceiptText", () => {
  it("skips total lines", () => {
    const text = "Shell\nPremium unleaded fuel\nTax $1.00\nTotal $20.00";
    expect(extractDescriptionFromReceiptText(text)).toBe("Premium unleaded fuel");
  });

  it("prefers subscription product lines", () => {
    const text = "Google\nGoogle Workspace Business Standard\nTotal $12.00";
    expect(extractDescriptionFromReceiptText(text)).toBe("Google Workspace Business Standard");
  });
});

describe("vendorFromFileName", () => {
  it("ignores numeric-only filenames", () => {
    expect(vendorFromFileName("5668729634.pdf")).toBe("");
  });

  it("uses readable filenames", () => {
    expect(vendorFromFileName("home-depot-receipt.pdf")).toBe("home depot receipt");
  });
});
