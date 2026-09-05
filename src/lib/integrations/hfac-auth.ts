import { createHmac, timingSafeEqual } from "node:crypto";

export const HFAC_REPLAY_WINDOW_MS = 5 * 60 * 1000;

export type HfacAuthMode = "hmac" | "legacy_bearer";

export type HfacAuthResult =
  | { ok: true; mode: HfacAuthMode; eventId?: string; timestamp?: string }
  | { ok: false; reason: string };

function extractBearerToken(header: string): string | null {
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function secureEqual(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function webhookSecret(): string | null {
  return (
    process.env.TELLER_HFAC_WEBHOOK_SECRET?.trim() ||
    process.env.TELLER_QUOTER_WEBHOOK_SECRET?.trim() ||
    null
  );
}

/** Temporary dual-mode: legacy bearer allowed unless explicitly disabled. */
export function legacyBearerAllowed(): boolean {
  const flag = process.env.TELLER_HFAC_WEBHOOK_LEGACY_BEARER?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "no") return false;
  return true;
}

function verifyTimestamp(timestamp: string): boolean {
  const unix = Number(timestamp);
  if (!Number.isFinite(unix) || unix <= 0) return false;
  const age = Math.abs(Date.now() - unix * 1000);
  return age <= HFAC_REPLAY_WINDOW_MS;
}

/** Verify HFAC webhook using bearer secret (constant-time). Migration-only path. */
export function hfacLegacyBearerAuthorized(request: Request): boolean {
  const secret = webhookSecret();
  if (!secret) return false;
  const token = extractBearerToken(request.headers.get("authorization") || "");
  if (!token) return false;
  return secureEqual(secret, token);
}

/**
 * Preferred HMAC verification.
 * Signature = HMAC-SHA256(secret, timestamp + "." + event_id + "." + raw_body)
 */
export function verifyHfacHmacSignature(
  request: Request,
  rawBody: string,
): { ok: true; eventId: string; timestamp: string } | { ok: false; reason: string } {
  const secret = webhookSecret();
  if (!secret) return { ok: false, reason: "missing_secret" };

  const eventId = request.headers.get("x-teller-event-id")?.trim() || "";
  const timestamp = request.headers.get("x-teller-timestamp")?.trim() || "";
  const signature = request.headers.get("x-teller-signature")?.trim() || "";

  if (!eventId || !timestamp || !signature) {
    return { ok: false, reason: "missing_signature_headers" };
  }
  if (!verifyTimestamp(timestamp)) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const payload = `${timestamp}.${eventId}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  if (!secureEqual(expected, signature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  return { ok: true, eventId, timestamp };
}

/** Authenticate inbound HFAC webhook. HMAC preferred; legacy bearer during migration. */
export function verifyHfacWebhookAuth(request: Request, rawBody: string): HfacAuthResult {
  const hmac = verifyHfacHmacSignature(request, rawBody);
  if (hmac.ok) {
    return {
      ok: true,
      mode: "hmac",
      eventId: hmac.eventId,
      timestamp: hmac.timestamp,
    };
  }

  if (legacyBearerAllowed() && hfacLegacyBearerAuthorized(request)) {
    return { ok: true, mode: "legacy_bearer" };
  }

  if (hmac.reason === "missing_signature_headers" && !legacyBearerAllowed()) {
    return { ok: false, reason: "missing_signature" };
  }

  return { ok: false, reason: hmac.reason };
}

/** Build signature for tests and HFAC client documentation. */
export function signHfacWebhookPayload(
  secret: string,
  eventId: string,
  timestamp: string,
  rawBody: string,
): string {
  const payload = `${timestamp}.${eventId}.${rawBody}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** @deprecated use verifyHfacWebhookAuth */
export function hfacWebhookAuthMode(request: Request, rawBody: string): boolean {
  return verifyHfacWebhookAuth(request, rawBody).ok;
}

/** @deprecated use hfacLegacyBearerAuthorized */
export function hfacWebhookAuthorized(request: Request): boolean {
  return hfacLegacyBearerAuthorized(request);
}

/** @deprecated use verifyHfacHmacSignature */
export function hfacWebhookSignatureAuthorized(request: Request, rawBody: string): boolean {
  return verifyHfacHmacSignature(request, rawBody).ok;
}
