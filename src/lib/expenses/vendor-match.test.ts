import { describe, expect, it } from "vitest";
import { matchVendorName, resolveVendorSuggestion } from "./vendor-match";

const vendors = [
  { id: "b", name: "Cursor" },
  { id: "a", name: "Cursor" },
  { id: "c", name: "Vercel" },
];

describe("matchVendorName", () => {
  it("reuses an existing vendor when the receipt name differs only by case or a legal suffix", () => {
    expect(matchVendorName("CURSOR, Inc.", vendors)?.id).toBe("a");
    expect(matchVendorName("vercel llc", vendors)?.id).toBe("c");
  });

  it("does not create a second match when several vendors share that name", () => {
    const again = matchVendorName("Cursor", vendors);
    expect(again?.id).toBe("a");
  });

  it("matches a shorter receipt name to one longer vendor", () => {
    const list = [{ id: "h", name: "The Home Depot" }];
    expect(matchVendorName("Home Depot", list)?.id).toBe("h");
  });

  it("leaves an unknown business unmatched", () => {
    expect(matchVendorName("Shell", vendors)).toBeNull();
  });

  it("does not treat a receipt number as a new vendor name", () => {
    expect(matchVendorName("5646133197", vendors)).toBeNull();
  });

  it("still reuses a numeric vendor that already exists", () => {
    const list = [...vendors, { id: "n", name: "5646133197" }];
    expect(matchVendorName("5646133197", list)?.id).toBe("n");
  });
});

describe("resolveVendorSuggestion", () => {
  it("prefers a name match over a different AI guess", () => {
    expect(resolveVendorSuggestion("Cursor", vendors, "c")?.id).toBe("a");
  });

  it("uses the AI vendor when the name is not already on the books", () => {
    expect(resolveVendorSuggestion("Anysphere", vendors, "b")).toMatchObject({
      id: "b",
      name: "Cursor",
    });
  });
});
