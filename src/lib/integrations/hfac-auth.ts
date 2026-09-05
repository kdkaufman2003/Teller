import { createHmac, timingSafeEqual } from "node:crypto";

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

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

function webhookSecret(): string | null {
  return (
    process.env.TELLER_HFAC_WEBHOOK_SECRET?.trim() ||
    process.env.TELLER_QUOTER_WEBHOOK_SECRET?.trim() ||
    null
  );
}

/** Verify HFAC webhook using bearer secret (constant-time). */
export function hfacWebhookAuthorized(request: Request): boolean {
  const secret = webhookSecret();
  if (!secret) return false;
  const token = extractBearerToken(request.headers.get("authorization") || "");
  if (!token) return false;
  return secureEqual(secret, token);
}

/**
 * Optional HMAC verification for future HFAC signed requests.
 * Header format: `X-Teller-Signature: t=<unix>,v1=<hex>`
 */
export function hfacWebhookSignatureAuthorized(
  request: Request,
  rawBody: string,
): boolean {
  const secret = webhookSecret();
  if (!secret) return false;

  const header = request.headers.get("x-teller-signature") || "";
  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, value] = part.trim().split("=");
      return [key, value ?? ""];
    }),
  );

  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const age = Math.abs(Date.now() - timestamp * 1000);
  if (age > REPLAY_WINDOW_MS) return false;

  const payload = `${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  return secureEqual(expected, signature);
}

export function hfacWebhookAuthMode(request: Request, rawBody: string): boolean {
  if (hfacWebhookSignatureAuthorized(request, rawBody)) return true;
  return hfacWebhookAuthorized(request);
}
