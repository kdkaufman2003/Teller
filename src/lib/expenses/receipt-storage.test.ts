import { describe, expect, it } from "vitest";
import {
  guessReceiptMime,
  isBrowserDisplayableImage,
  isPdfMime,
} from "./receipt-storage";

describe("guessReceiptMime", () => {
  it("detects common receipt types", () => {
    expect(guessReceiptMime("org/id/receipt.pdf")).toBe("application/pdf");
    expect(guessReceiptMime("org/id/receipt.png")).toBe("image/png");
    expect(guessReceiptMime("org/id/receipt.heic")).toBe("image/heic");
  });
});

describe("receipt preview helpers", () => {
  it("knows pdf vs displayable images", () => {
    expect(isPdfMime("application/pdf")).toBe(true);
    expect(isBrowserDisplayableImage("image/jpeg")).toBe(true);
    expect(isBrowserDisplayableImage("image/heic")).toBe(false);
  });
});
