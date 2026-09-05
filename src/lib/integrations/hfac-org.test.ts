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
  it("rejects organizationId-only payloads", async () => {
    await expect(
      resolveHfacWebhookOrganization({ from: vi.fn() } as never, {
        organizationId: "org-1",
      }),
    ).rejects.toMatchObject({ reason: "missing_external_id" });
  });

  it("maps external HFAC id to the linked organization", async () => {
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          in: vi.fn().mockResolvedValue({
            data: [
              {
                organization_id: "org-mapped",
                provider: "hfac",
                enabled: true,
                config: { external_account_id: "hfac-co-99", status: "active" },
              },
            ],
          }),
        })),
      })),
    };

    const result = await resolveHfacWebhookOrganization(supabase as never, {
      companyId: "hfac-co-99",
      organizationId: "org-mapped",
    });
    expect(result.organizationId).toBe("org-mapped");
    expect(result.externalAccountId).toBe("hfac-co-99");
  });

  it("rejects unknown external organization", async () => {
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          in: vi.fn().mockResolvedValue({ data: [] }),
        })),
      })),
    };

    await expect(
      resolveHfacWebhookOrganization(supabase as never, { companyId: "missing-co" }),
    ).rejects.toMatchObject({ reason: "unknown_external_organization" });
  });

  it("rejects mismatched organizationId and external HFAC id", async () => {
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          in: vi.fn().mockResolvedValue({
            data: [
              {
                organization_id: "org-real",
                provider: "hfac",
                enabled: true,
                config: { external_account_id: "hfac-co-99", status: "active" },
              },
            ],
          }),
        })),
      })),
    };

    await expect(
      resolveHfacWebhookOrganization(supabase as never, {
        companyId: "hfac-co-99",
        organizationId: "org-attacker",
      }),
    ).rejects.toMatchObject({ reason: "organization_mismatch" });
  });

  it("rejects inactive integration mappings", async () => {
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          in: vi.fn().mockResolvedValue({
            data: [
              {
                organization_id: "org-real",
                provider: "hfac",
                enabled: false,
                config: { external_account_id: "hfac-co-99" },
              },
            ],
          }),
        })),
      })),
    };

    await expect(
      resolveHfacWebhookOrganization(supabase as never, { companyId: "hfac-co-99" }),
    ).rejects.toMatchObject({ reason: "unknown_external_organization" });
  });
});
