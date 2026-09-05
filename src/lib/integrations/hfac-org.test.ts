import { describe, expect, it, vi } from "vitest";
import {
  extractHfacExternalId,
  HfacOrgRejectedError,
  resolveHfacWebhookOrganization,
  secureCompare,
} from "./hfac-org";

describe("extractHfacExternalId", () => {
  it("reads top-level company id", () => {
    expect(extractHfacExternalId({ companyId: "hfac-co-1" })).toBe("hfac-co-1");
  });

  it("reads nested payment company id", () => {
    expect(
      extractHfacExternalId({
        payment: { companyId: "hfac-co-2" },
      }),
    ).toBe("hfac-co-2");
  });
});

describe("secureCompare", () => {
  it("matches equal strings", () => {
    expect(secureCompare("secret", "secret")).toBe(true);
  });

  it("rejects different strings", () => {
    expect(secureCompare("secret", "other")).toBe(false);
  });
});

describe("resolveHfacWebhookOrganization", () => {
  it("accepts legacy organizationId when HFAC integration is active", async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "teller_integrations") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ provider: "hfac", enabled: true, config: {} }],
                }),
              }),
            }),
          };
        }
        if (table === "teller_organizations") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: "org-1" } }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    };

    const result = await resolveHfacWebhookOrganization(
      supabase as never,
      { organizationId: "org-1" },
    );
    expect(result.organizationId).toBe("org-1");
  });

  it("rejects arbitrary organization without active integration", async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "teller_integrations") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: [] }),
              }),
            }),
          };
        }
        if (table === "teller_organizations") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: "victim-org" } }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    };

    await expect(
      resolveHfacWebhookOrganization(supabase as never, {
        organizationId: "victim-org",
      }),
    ).rejects.toBeInstanceOf(HfacOrgRejectedError);
  });

  it("maps external HFAC id to the linked organization", async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table !== "teller_integrations") {
          throw new Error(`unexpected table ${table}`);
        }
        return {
          select: vi.fn((cols: string) => {
            if (cols.includes("organization_id")) {
              return {
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({
                    data: [
                      {
                        organization_id: "org-mapped",
                        provider: "hfac",
                        enabled: true,
                        config: { external_account_id: "hfac-co-99" },
                      },
                    ],
                  }),
                }),
              };
            }
            return {
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ provider: "hfac", enabled: true, config: {} }],
                }),
              }),
            };
          }),
        };
      }),
    };

    const result = await resolveHfacWebhookOrganization(supabase as never, {
      companyId: "hfac-co-99",
      organizationId: "org-mapped",
    });
    expect(result.organizationId).toBe("org-mapped");
  });

  it("rejects mismatched organizationId and external HFAC id", async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "teller_integrations") {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({
                  data: [
                    {
                      organization_id: "org-real",
                      provider: "hfac",
                      enabled: true,
                      config: { external_account_id: "hfac-co-99" },
                    },
                  ],
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    };

    await expect(
      resolveHfacWebhookOrganization(supabase as never, {
        companyId: "hfac-co-99",
        organizationId: "org-attacker",
      }),
    ).rejects.toMatchObject({ reason: "organization_mismatch" });
  });
});
