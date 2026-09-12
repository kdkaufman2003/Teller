import { describe, expect, it, vi } from "vitest";
import * as service from "./legal-entity/service";
import { resolveActiveLegalEntityContext } from "./legal-entity/active-context";
import { resolveAuthorizedLegalEntity } from "./legal-entity/resolver";
import {
  canAccessLegalEntity,
  grantEntityAccess,
  hasAllEntityAccess,
  revokeEntityAccess,
} from "./legal-entity/access";
import { organizationHasActiveHfacIntegration } from "./legal-entity/service";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENTITY_1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const ENTITY_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";
const ENTITY_FOREIGN = "ffffffff-ffff-4fff-8fff-fffffffffff1";

function entityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTITY_1,
    organizationId: ORG_A,
    name: "Acme Kansas",
    legalName: "Acme Kansas LLC",
    entityCode: "KC",
    entityType: "llc" as const,
    baseCurrency: "USD",
    isDefault: true,
    isActive: true,
    consolidationEnabled: false,
    ...overrides,
  };
}

function mockSupabase(handlers: {
  entities?: Record<string, unknown>[];
  integrations?: Record<string, unknown> | null;
}) {
  const entities = handlers.entities ?? [entityRow()];

  const from = vi.fn((table: string) => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(),
      single: vi.fn(),
      insert: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
    };

    if (table === "teller_legal_entities") {
      chain.eq = vi.fn((column: string, value: string) => {
        if (column === "id") {
          const row = entities.find((item) => item.id === value) ?? null;
          const dbRow = row
            ? {
                ...row,
                organization_id: row.organizationId ?? ORG_A,
                legal_name: row.legalName ?? row.name,
                entity_code: row.entityCode,
                entity_type: row.entityType,
                base_currency: row.baseCurrency,
                is_default: row.isDefault,
                is_active: row.isActive,
                consolidation_enabled: row.consolidationEnabled,
              }
            : null;
          chain.maybeSingle = vi.fn(async () => ({ data: dbRow, error: null }));
          chain.single = vi.fn(async () => ({ data: dbRow, error: null }));
        }
        return chain;
      });
    }

    if (table === "teller_legal_entity_memberships") {
      chain.insert = vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: {
              id: "mem-1",
              organization_id: ORG_A,
              legal_entity_id: ENTITY_1,
              profile_id: USER_A,
            },
            error: null,
          })),
        })),
      }));
    }

    if (table === "teller_integrations") {
      chain.maybeSingle = vi.fn(async () => ({
        data: handlers.integrations ?? null,
        error: null,
      }));
    }

    return chain;
  });

  return { from } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

describe("Phase 16B owner entity access", () => {
  it("owner has all-entity access without explicit memberships", () => {
    expect(hasAllEntityAccess("owner")).toBe(true);
    expect(hasAllEntityAccess("admin")).toBe(true);
    expect(hasAllEntityAccess("bookkeeper")).toBe(false);
  });
});

function mockMembershipSupabase(options: { membershipCount: number; hasGrant: boolean }) {
  return {
    from: vi.fn((table: string) => {
      if (table !== "teller_legal_entity_memberships") {
        return mockSupabase({}).from(table);
      }
      return {
        select: vi.fn((_cols: string, opts?: { head?: boolean; count?: string }) => {
          if (opts?.head) {
            return {
              eq: vi.fn(() => ({
                eq: vi.fn(async () => ({ count: options.membershipCount, error: null })),
              })),
            };
          }
          return {
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: options.hasGrant ? { id: "mem-1" } : null,
                    error: null,
                  })),
                })),
              })),
            })),
          };
        }),
      };
    }),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

describe("Phase 16B restricted entity access", () => {
  it("denies same-org unauthorized entity when memberships exist", async () => {
    const supabase = mockMembershipSupabase({ membershipCount: 1, hasGrant: false });

    await expect(
      canAccessLegalEntity(supabase, {
        organizationId: ORG_A,
        legalEntityId: ENTITY_2,
        auth: { userId: USER_A, role: "bookkeeper" },
      }),
    ).resolves.toBe(false);
  });

  it("allows assigned entity for restricted user", async () => {
    const supabase = mockMembershipSupabase({ membershipCount: 1, hasGrant: true });

    await expect(
      canAccessLegalEntity(supabase, {
        organizationId: ORG_A,
        legalEntityId: ENTITY_1,
        auth: { userId: USER_A, role: "bookkeeper" },
      }),
    ).resolves.toBe(true);
  });
});

describe("Phase 16B authorized resolver", () => {
  it("rejects cross-org entity when auth is enforced", async () => {
    const supabase = mockSupabase({
      entities: [entityRow({ id: ENTITY_FOREIGN, organizationId: ORG_B })],
    });

    await expect(
      resolveAuthorizedLegalEntity(supabase, {
        organizationId: ORG_A,
        requestedLegalEntityId: ENTITY_FOREIGN,
        auth: { userId: USER_A, role: "owner" },
      }),
    ).rejects.toThrow(/organization/i);
  });

  it("rejects inactive entity for new activity", async () => {
    const supabase = mockSupabase({
      entities: [entityRow({ isActive: false })],
    });

    await expect(
      resolveAuthorizedLegalEntity(supabase, {
        organizationId: ORG_A,
        requestedLegalEntityId: ENTITY_1,
        auth: { userId: USER_A, role: "owner" },
      }),
    ).rejects.toThrow(/archived/i);
  });
});

describe("Phase 16B active context", () => {
  it("auto-selects the only accessible entity", async () => {
    vi.spyOn(service, "listLegalEntities").mockResolvedValue([entityRow()]);
    const supabase = mockSupabase({});

    const context = await resolveActiveLegalEntityContext(supabase, {
      organizationId: ORG_A,
      auth: { userId: USER_A, role: "bookkeeper" },
    });

    expect(context.legalEntity.id).toBe(ENTITY_1);
    expect(context.showEntitySwitcher).toBe(false);
    vi.restoreAllMocks();
  });

  it("shows switcher when multiple accessible entities exist", async () => {
    vi.spyOn(service, "listLegalEntities").mockResolvedValue([
      entityRow(),
      entityRow({ id: ENTITY_2, entityCode: "MO", isDefault: false }),
    ]);
    const supabase = mockSupabase({});

    const context = await resolveActiveLegalEntityContext(supabase, {
      organizationId: ORG_A,
      auth: { userId: USER_A, role: "owner" },
      persistedLegalEntityId: ENTITY_1,
    });

    expect(context.showEntitySwitcher).toBe(true);
    expect(context.accessibleEntities).toHaveLength(2);
    vi.restoreAllMocks();
  });
});

describe("Phase 16B HFAC default change guard", () => {
  it("detects active HFAC integration", async () => {
    const supabase = mockSupabase({ integrations: { enabled: true } });
    await expect(organizationHasActiveHfacIntegration(supabase, ORG_A)).resolves.toBe(true);
  });
});

describe("Phase 16B membership mutations", () => {
  it("grants entity access", async () => {
    const supabase = mockSupabase({});
    const membership = await grantEntityAccess(supabase, {
      organizationId: ORG_A,
      legalEntityId: ENTITY_1,
      profileId: USER_A,
    });
    expect(membership.profileId).toBe(USER_A);
  });

  it("revokes entity access", async () => {
    const supabase = mockSupabase({});
    await expect(
      revokeEntityAccess(supabase, {
        organizationId: ORG_A,
        legalEntityId: ENTITY_1,
        profileId: USER_A,
      }),
    ).resolves.toBeUndefined();
  });
});
