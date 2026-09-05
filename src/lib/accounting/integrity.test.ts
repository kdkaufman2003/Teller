import { describe, expect, it } from "vitest";
import { assertBalanced } from "./post";

describe("integrity journal checks", () => {
  it("detects unbalanced journal entries via assertBalanced", () => {
    expect(() =>
      assertBalanced([
        { account_id: "a", debit: 100 },
        { account_id: "b", credit: 90 },
      ]),
    ).toThrow(/unbalanced/i);
  });
});
