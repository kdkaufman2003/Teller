import { describe, expect, it } from "vitest";
import {
  assertNotHfacOrganization,
  CONTROLLED_FOREIGN_TEST_ORG_NAME,
  CONTROLLED_TEST_ORG_NAME,
  evaluateControlledProdTestSafety,
  isControlledTestOrgName,
  TELLER_HFAC_ORG_ID,
} from "./controlled-prod-test";

describe("controlled production test guards", () => {
  it("requires TELLER_CONTROLLED_PROD_TEST=1 on production ref", () => {
    const ok = evaluateControlledProdTestSafety({
      supabaseUrl: "https://ypixbxicdecwfafculha.supabase.co",
      controlledProdTest: "1",
      testOrganizationId: "00000000-0000-4000-8000-000000000001",
    });
    expect(ok.allowed).toBe(true);

    const blocked = evaluateControlledProdTestSafety({
      supabaseUrl: "https://ypixbxicdecwfafculha.supabase.co",
      controlledProdTest: "0",
      testOrganizationId: "00000000-0000-4000-8000-000000000001",
    });
    expect(blocked.allowed).toBe(false);
  });

  it("blocks when integration destructive flags are enabled", () => {
    const prevRun = process.env.RUN_INTEGRATION_TESTS;
    process.env.RUN_INTEGRATION_TESTS = "1";
    const result = evaluateControlledProdTestSafety({
      supabaseUrl: "https://ypixbxicdecwfafculha.supabase.co",
      controlledProdTest: "1",
      testOrganizationId: "00000000-0000-4000-8000-000000000001",
    });
    expect(result.allowed).toBe(false);
    process.env.RUN_INTEGRATION_TESTS = prevRun;
  });

  it("refuses HFAC org as test org", () => {
    const result = evaluateControlledProdTestSafety({
      supabaseUrl: "https://ypixbxicdecwfafculha.supabase.co",
      controlledProdTest: "1",
      testOrganizationId: TELLER_HFAC_ORG_ID,
    });
    expect(result.allowed).toBe(false);
  });

  it("recognizes approved test org names", () => {
    expect(isControlledTestOrgName(CONTROLLED_TEST_ORG_NAME)).toBe(true);
    expect(isControlledTestOrgName(CONTROLLED_FOREIGN_TEST_ORG_NAME)).toBe(true);
    expect(isControlledTestOrgName("Hassle Free AC")).toBe(false);
  });

  it("assertNotHfacOrganization throws for HFAC id", () => {
    expect(() => assertNotHfacOrganization(TELLER_HFAC_ORG_ID)).toThrow(/Hassle Free AC/i);
  });
});
