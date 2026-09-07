import { describe, expect, it } from "vitest";
import {
  assertValidDisposalOperationId,
  disposeFixedAsset,
} from "./fixed-asset-disposal";

describe("disposal operationId validation", () => {
  it("rejects missing operationId", () => {
    expect(() => assertValidDisposalOperationId(undefined)).toThrow(/operationId is required/i);
    expect(() => assertValidDisposalOperationId("")).toThrow(/operationId is required/i);
  });

  it("rejects invalid UUID format", () => {
    expect(() => assertValidDisposalOperationId("not-a-uuid")).toThrow(/valid UUID/i);
    expect(() => assertValidDisposalOperationId("dispose:asset:date")).toThrow(/valid UUID/i);
  });

  it("accepts valid UUID", () => {
    expect(() => assertValidDisposalOperationId("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
  });

  it("disposeFixedAsset rejects before RPC when operationId missing", async () => {
    await expect(
      disposeFixedAsset({ rpc: async () => ({ data: null, error: null }) } as never, {
        organizationId: "550e8400-e29b-41d4-a716-446655440001",
        assetId: "550e8400-e29b-41d4-a716-446655440002",
        disposalDate: "2026-01-01",
        disposalType: "retired",
        operationId: "",
      }),
    ).rejects.toThrow(/operationId is required/i);
  });
});
