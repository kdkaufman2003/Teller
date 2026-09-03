import { describe, expect, it } from "vitest";
import { assertBalanced } from "./post";

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
