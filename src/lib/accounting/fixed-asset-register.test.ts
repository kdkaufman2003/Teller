import { describe, expect, it } from "vitest";
import { batchSumPostedDepreciationForAssets } from "./fixed-assets";

describe("batchSumPostedDepreciationForAssets", () => {
  it("aggregates posted depreciation per asset in one pass", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          in: () => ({
            eq: async () => ({
              data: [
                { asset_id: "a1", amount: 100, status: "posted" },
                { asset_id: "a1", amount: 50, status: "posted" },
                { asset_id: "a2", amount: 25, status: "posted" },
              ],
              error: null,
            }),
          }),
        }),
      }),
    };

    const map = await batchSumPostedDepreciationForAssets(
      supabase as never,
      ["a1", "a2", "a3"],
    );
    expect(map.get("a1")).toBe(150);
    expect(map.get("a2")).toBe(25);
    expect(map.get("a3")).toBe(0);
  });
});
