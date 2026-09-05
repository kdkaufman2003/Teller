import { describe, expect, it, vi } from "vitest";
import {
  signHfacWebhookPayload,
  verifyHfacHmacSignature,
  verifyHfacWebhookAuth,
} from "@/lib/integrations/hfac-auth";
import {
  HfacOrgRejectedError,
  resolveHfacWebhookOrganization,
  setHfacExternalMapping,
} from "@/lib/integrations/hfac-org";
import {
  createIntegrationClient,
  createTestOrganization,
  deleteTestOrganization,
  integrationTestsEnabled,
} from "./helpers";

describe("HFAC HMAC auth", () => {
  const secret = "test-signing-secret";

  it("accepts valid signed payloads", () => {
    const previous = process.env.TELLER_HFAC_WEBHOOK_SECRET;
    process.env.TELLER_HFAC_WEBHOOK_SECRET = secret;
    try {
      const rawBody = JSON.stringify({ companyId: "co-1", payment: { amount: 100 } });
      const eventId = "evt-123";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signHfacWebhookPayload(secret, eventId, timestamp, rawBody);
      const request = new Request("http://localhost/api/integrations/hfac/payments", {
        method: "POST",
        headers: {
          "X-Teller-Event-Id": eventId,
          "X-Teller-Timestamp": timestamp,
          "X-Teller-Signature": signature,
        },
        body: rawBody,
      });

      const result = verifyHfacWebhookAuth(request, rawBody);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.mode).toBe("hmac");
        expect(result.eventId).toBe(eventId);
      }
    } finally {
      process.env.TELLER_HFAC_WEBHOOK_SECRET = previous;
    }
  });

  it("rejects stale timestamps", () => {
    const previous = process.env.TELLER_HFAC_WEBHOOK_SECRET;
    process.env.TELLER_HFAC_WEBHOOK_SECRET = secret;
    try {
      const rawBody = "{}";
      const eventId = "evt-stale";
      const timestamp = String(Math.floor(Date.now() / 1000) - 3600);
      const signature = signHfacWebhookPayload(secret, eventId, timestamp, rawBody);
      const request = new Request("http://localhost", {
        method: "POST",
        headers: {
          "X-Teller-Event-Id": eventId,
          "X-Teller-Timestamp": timestamp,
          "X-Teller-Signature": signature,
        },
      });
      expect(verifyHfacHmacSignature(request, rawBody).ok).toBe(false);
    } finally {
      process.env.TELLER_HFAC_WEBHOOK_SECRET = previous;
    }
  });
});

describe("resolveHfacWebhookOrganization strict mapping", () => {
  it("rejects organizationId-only payloads", async () => {
    const supabase = {
      from: vi.fn(() => {
        throw new Error("should not query when external id missing");
      }),
    };

    await expect(
      resolveHfacWebhookOrganization(supabase as never, { organizationId: "org-1" }),
    ).rejects.toMatchObject({ reason: "missing_external_id" });
  });
});

const enabled = integrationTestsEnabled();

describe.skipIf(!enabled)("HFAC integration mapping", () => {
  const supabase = enabled ? createIntegrationClient() : null!;

  it("resolves organization exclusively from external mapping", async () => {
    const { organizationId } = await createTestOrganization(supabase, "hfac-map");
    const externalId = `hfac-co-${Date.now()}`;
    try {
      await supabase.from("teller_integrations").upsert({
        organization_id: organizationId,
        provider: "hfac",
        enabled: true,
        config: {},
      });

      await setHfacExternalMapping(supabase, organizationId, externalId);

      const resolved = await resolveHfacWebhookOrganization(supabase, {
        companyId: externalId,
        organizationId,
      });
      expect(resolved.organizationId).toBe(organizationId);

      await expect(
        resolveHfacWebhookOrganization(supabase, {
          companyId: externalId,
          organizationId: "00000000-0000-0000-0000-000000000999",
        }),
      ).rejects.toBeInstanceOf(HfacOrgRejectedError);
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });

  it("rejects unknown external company", async () => {
    await expect(
      resolveHfacWebhookOrganization(supabase, {
        companyId: `missing-co-${Date.now()}`,
      }),
    ).rejects.toMatchObject({ reason: "unknown_external_organization" });
  });

  it("rejects inactive integration mappings", async () => {
    const { organizationId } = await createTestOrganization(supabase, "hfac-inactive");
    const externalId = `hfac-co-inactive-${Date.now()}`;
    try {
      await supabase.from("teller_integrations").upsert({
        organization_id: organizationId,
        provider: "hfac",
        enabled: false,
        config: { external_account_id: externalId, status: "inactive" },
      });

      await expect(
        resolveHfacWebhookOrganization(supabase, { companyId: externalId }),
      ).rejects.toMatchObject({ reason: "unknown_external_organization" });
    } finally {
      await deleteTestOrganization(supabase, organizationId);
    }
  });
});
