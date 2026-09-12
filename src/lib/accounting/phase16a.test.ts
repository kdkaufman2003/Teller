import { describe, expect, it, vi } from "vitest";
import { accountingContext } from "./legal-entity/context";
import {
  loadLegalEntityForOrg,
  requireDefaultLegalEntity,
  resolveAuthorizedLegalEntity,
  resolveDefaultLegalEntity,
} from "./legal-entity/resolver";
import {
  assertSameOrganization,
  normalizeEntityCode,
  validateEntityCode,
} from "./legal-entity/validation";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ENTITY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function mockSupabase(rows: Record<string, unknown> | null, error: { message: string } | null = null) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: rows, error }),
  };
  return {
    from: vi.fn().mockReturnValue(chain),
    _chain: chain,
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

describe("Phase 16A entity code validation", () => {
  it("normalizes and validates entity codes", () => {
    expect(normalizeEntityCode(" kc ")).toBe("KC");
    expect(validateEntityCode("WICHITA").ok).toBe(true);
    expect(validateEntityCode("").ok).toBe(false);
    expect(validateEntityCode("bad code!").ok).toBe(false);
  });
});

describe("Phase 16A organization boundary", () => {
  it("rejects cross-org entity access", () => {
    expect(() => assertSameOrganization(ORG_A, ORG_B)).toThrow(/organization/i);
  });
});

describe("Phase 16A accounting context", () => {
  it("requires organization and legal entity ids", () => {
    expect(accountingContext(ORG_A, ENTITY_A)).toEqual({
      organizationId: ORG_A,
      legalEntityId: ENTITY_A,
    });
    expect(() => accountingContext("", ENTITY_A)).toThrow(/organizationId/i);
    expect(() => accountingContext(ORG_A, "")).toThrow(/legalEntityId/i);
  });
});

describe("Phase 16A default entity resolver", () => {
  it("returns default entity for org", async () => {
    const supabase = mockSupabase({
      id: ENTITY_A,
      organization_id: ORG_A,
      name: "Acme",
      legal_name: "Acme LLC",
      entity_code: "MAIN",
      entity_type: "llc",
      base_currency: "USD",
      is_default: true,
      is_active: true,
      consolidation_enabled: false,
    });
    const entity = await resolveDefaultLegalEntity(supabase, ORG_A);
    expect(entity?.entityCode).toBe("MAIN");
    expect(entity?.isDefault).toBe(true);
  });

  it("throws when default entity missing", async () => {
    const supabase = mockSupabase(null);
    await expect(requireDefaultLegalEntity(supabase, ORG_A)).rejects.toThrow(/default legal entity/i);
  });
});

describe("Phase 16A authorized entity resolution", () => {
  it("resolves explicit entity when org matches", async () => {
    const supabase = mockSupabase({
      id: ENTITY_A,
      organization_id: ORG_A,
      name: "Branch",
      legal_name: "Branch LLC",
      entity_code: "KC",
      entity_type: "llc",
      base_currency: "USD",
      is_default: false,
      is_active: true,
      consolidation_enabled: false,
    });
    const entity = await resolveAuthorizedLegalEntity(supabase, {
      organizationId: ORG_A,
      requestedLegalEntityId: ENTITY_A,
    });
    expect(entity.entityCode).toBe("KC");
  });

  it("rejects foreign-org entity", async () => {
    const supabase = mockSupabase({
      id: ENTITY_A,
      organization_id: ORG_B,
      name: "Foreign",
      legal_name: "Foreign LLC",
      entity_code: "X",
      entity_type: "llc",
      base_currency: "USD",
      is_default: true,
      is_active: true,
      consolidation_enabled: false,
    });
    await expect(loadLegalEntityForOrg(supabase, ORG_A, ENTITY_A)).rejects.toThrow(/organization/i);
  });

  it("rejects inactive entity unless allowed", async () => {
    const supabase = mockSupabase({
      id: ENTITY_A,
      organization_id: ORG_A,
      name: "Inactive",
      legal_name: "Inactive LLC",
      entity_code: "OLD",
      entity_type: "llc",
      base_currency: "USD",
      is_default: false,
      is_active: false,
      consolidation_enabled: false,
    });
    await expect(
      resolveAuthorizedLegalEntity(supabase, {
        organizationId: ORG_A,
        requestedLegalEntityId: ENTITY_A,
      }),
    ).rejects.toThrow(/archived|inactive/i);
  });
});

describe("Phase 16A architectural invariants (design)", () => {
  it("documents cross-entity journal prohibition as false allowance", () => {
    const CROSS_ENTITY_SINGLE_JOURNAL_ALLOWED = false;
    expect(CROSS_ENTITY_SINGLE_JOURNAL_ALLOWED).toBe(false);
  });

  it("documents shared party does not share AR/AP balances", () => {
    const SHARED_PARTY_DOES_NOT_SHARE_AR_AP_BALANCES = true;
    expect(SHARED_PARTY_DOES_NOT_SHARE_AR_AP_BALANCES).toBe(true);
  });
});
