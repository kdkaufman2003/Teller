import { describe, expect, it } from "vitest";
import {
  assertDistinctControlledDemoOrgIds,
  assertMutationScope,
  loadPriorPhasePeerOrgIds,
} from "./controlled-phase-isolation";

describe("controlled phase isolation", () => {
  it("rejects duplicate demo org IDs across phases", () => {
    process.env.TELLER_PHASE5_DEMO_ORG_ID = "11111111-1111-4111-8111-111111111111";
    process.env.TELLER_PHASE6_DEMO_ORG_ID = "11111111-1111-4111-8111-111111111111";
    process.env.TELLER_PHASE7_DEMO_ORG_ID = "22222222-2222-4222-8222-222222222222";
    process.env.TELLER_PHASE8_DEMO_ORG_ID = "33333333-3333-4333-8333-333333333333";
    process.env.TELLER_PHASE9_DEMO_ORG_ID = "44444444-4444-4444-8444-444444444444";
    process.env.TELLER_PHASE10_DEMO_ORG_ID = "55555555-5555-4555-8555-555555555555";

    expect(() => assertDistinctControlledDemoOrgIds()).toThrow(/distinct/i);
  });

  it("rejects mutations outside active demo org", () => {
    const allowed = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expect(() => assertMutationScope(other, allowed)).toThrow(/outside active phase demo org/i);
    expect(() => assertMutationScope(allowed, allowed)).not.toThrow();
  });

  it("loads only prior-phase peer org ids from env", () => {
    process.env.TELLER_PHASE5_DEMO_ORG_ID = "11111111-1111-4111-8111-111111111111";
    process.env.TELLER_PHASE6_DEMO_ORG_ID = "22222222-2222-4222-8222-222222222222";
    process.env.TELLER_PHASE7_DEMO_ORG_ID = "33333333-3333-4333-8333-333333333333";
    process.env.TELLER_PHASE8_DEMO_ORG_ID = "44444444-4444-4444-8444-444444444444";
    process.env.TELLER_PHASE9_DEMO_ORG_ID = "55555555-5555-4555-8555-555555555555";
    process.env.TELLER_PHASE10_DEMO_ORG_ID = "66666666-6666-4666-8666-666666666666";

    const peers = loadPriorPhasePeerOrgIds(9);
    expect(Object.keys(peers).map(Number).sort()).toEqual([5, 6, 7, 8]);
    expect(peers[8]).toBe(process.env.TELLER_PHASE8_DEMO_ORG_ID);
    expect(peers[9]).toBeUndefined();
  });
});
