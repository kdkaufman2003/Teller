import { describe, expect, it } from "vitest";
import {
  hfacLegacyBearerAuthorized,
  legacyBearerAllowed,
  signHfacWebhookPayload,
  verifyHfacWebhookAuth,
} from "./hfac-auth";

describe("verifyHfacWebhookAuth", () => {
  it("prefers HMAC over legacy bearer", () => {
    const secret = "phase05-secret";
    const previous = process.env.TELLER_HFAC_WEBHOOK_SECRET;
    process.env.TELLER_HFAC_WEBHOOK_SECRET = secret;
    try {
      const rawBody = '{"companyId":"co-1"}';
      const eventId = "evt-1";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signHfacWebhookPayload(secret, eventId, timestamp, rawBody);
      const request = new Request("http://localhost", {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong",
          "X-Teller-Event-Id": eventId,
          "X-Teller-Timestamp": timestamp,
          "X-Teller-Signature": signature,
        },
      });

      const result = verifyHfacWebhookAuth(request, rawBody);
      expect(result).toMatchObject({ ok: true, mode: "hmac" });
    } finally {
      process.env.TELLER_HFAC_WEBHOOK_SECRET = previous;
    }
  });

  it("allows legacy bearer only while migration flag is enabled", () => {
    const secret = "legacy-secret";
    const previousSecret = process.env.TELLER_HFAC_WEBHOOK_SECRET;
    const previousLegacy = process.env.TELLER_HFAC_WEBHOOK_LEGACY_BEARER;
    process.env.TELLER_HFAC_WEBHOOK_SECRET = secret;
    process.env.TELLER_HFAC_WEBHOOK_LEGACY_BEARER = "true";
    try {
      const rawBody = "{}";
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect(verifyHfacWebhookAuth(request, rawBody)).toMatchObject({
        ok: true,
        mode: "legacy_bearer",
      });
    } finally {
      process.env.TELLER_HFAC_WEBHOOK_SECRET = previousSecret;
      process.env.TELLER_HFAC_WEBHOOK_LEGACY_BEARER = previousLegacy;
    }
  });

  it("rejects legacy bearer when migration mode is disabled", () => {
    const secret = "legacy-secret";
    const previousSecret = process.env.TELLER_HFAC_WEBHOOK_SECRET;
    const previousLegacy = process.env.TELLER_HFAC_WEBHOOK_LEGACY_BEARER;
    process.env.TELLER_HFAC_WEBHOOK_SECRET = secret;
    process.env.TELLER_HFAC_WEBHOOK_LEGACY_BEARER = "false";
    try {
      const rawBody = "{}";
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect(verifyHfacWebhookAuth(request, rawBody)).toMatchObject({
        ok: false,
        reason: "missing_signature",
      });
      expect(legacyBearerAllowed()).toBe(false);
      expect(hfacLegacyBearerAuthorized(request)).toBe(true);
    } finally {
      process.env.TELLER_HFAC_WEBHOOK_SECRET = previousSecret;
      process.env.TELLER_HFAC_WEBHOOK_LEGACY_BEARER = previousLegacy;
    }
  });
});
