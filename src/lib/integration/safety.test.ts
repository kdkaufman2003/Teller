import { describe, expect, it } from "vitest";
import {
  assertSafeIntegrationDatabase,
  evaluateExpectedBranch,
  evaluateIntegrationDatabaseSafety,
  isDeniedProductionSupabaseRef,
  parseSupabaseProjectRef,
  TELLER_PRODUCTION_SUPABASE_PROJECT_REFS,
} from "./safety";

describe("parseSupabaseProjectRef", () => {
  it("extracts project ref from standard Supabase URL", () => {
    expect(parseSupabaseProjectRef("https://abc123xyz.supabase.co")).toBe("abc123xyz");
  });

  it("returns null for missing or invalid URLs", () => {
    expect(parseSupabaseProjectRef("")).toBeNull();
    expect(parseSupabaseProjectRef("not-a-url")).toBeNull();
    expect(parseSupabaseProjectRef("https://example.com")).toBeNull();
  });
});

describe("production ref denylist", () => {
  it("includes the known Teller production ref", () => {
    expect(TELLER_PRODUCTION_SUPABASE_PROJECT_REFS).toContain("ypixbxicdecwfafculha");
    expect(isDeniedProductionSupabaseRef("ypixbxicdecwfafculha")).toBe(true);
  });

  it("allows other refs", () => {
    expect(isDeniedProductionSupabaseRef("isolated-test-ref")).toBe(false);
  });
});

describe("evaluateExpectedBranch", () => {
  it("passes when branch matches", () => {
    const result = evaluateExpectedBranch({
      expectedBranch: "phase4-testing",
      currentBranch: "phase4-testing",
    });
    expect(result.allowed).toBe(true);
  });

  it("rejects when branch mismatches", () => {
    const result = evaluateExpectedBranch({
      expectedBranch: "phase4-testing",
      currentBranch: "main",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/does not match/i);
  });

  it("skips check when expected branch unset", () => {
    expect(evaluateExpectedBranch({ expectedBranch: "", currentBranch: "main" }).allowed).toBe(
      true,
    );
  });
});

describe("evaluateIntegrationDatabaseSafety", () => {
  it("rejects production ref even with opt-in flags", () => {
    const result = evaluateIntegrationDatabaseSafety({
      supabaseUrl: "https://ypixbxicdecwfafculha.supabase.co",
      runIntegrationTests: "1",
      allowIntegrationDb: "1",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/production/i);
  });

  it("requires explicit opt-in flags", () => {
    const base = {
      supabaseUrl: "https://isolated-test-ref.supabase.co",
    };
    expect(
      evaluateIntegrationDatabaseSafety({
        ...base,
        runIntegrationTests: "1",
        allowIntegrationDb: "0",
      }).allowed,
    ).toBe(false);
    expect(
      evaluateIntegrationDatabaseSafety({
        ...base,
        runIntegrationTests: "0",
        allowIntegrationDb: "1",
      }).allowed,
    ).toBe(false);
  });

  it("allows isolated ref with both opt-in flags", () => {
    const result = evaluateIntegrationDatabaseSafety({
      supabaseUrl: "https://isolatedtestref.supabase.co",
      runIntegrationTests: "1",
      allowIntegrationDb: "1",
    });
    expect(result.allowed).toBe(true);
    expect(result.projectRef).toBe("isolatedtestref");
  });
});

describe("assertSafeIntegrationDatabase", () => {
  it("throws on production ref", () => {
    expect(() =>
      assertSafeIntegrationDatabase({
        supabaseUrl: "https://ypixbxicdecwfafculha.supabase.co",
        runIntegrationTests: "1",
        allowIntegrationDb: "1",
      }),
    ).toThrow(/Unsafe integration database/i);
  });
});
