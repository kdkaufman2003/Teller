import { createHash } from "node:crypto";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Deterministic UUID-shaped id from a stable seed (client retry without storing UUID). */
export function deterministicEventId(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `a${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

export function normalizeIdempotencyKey(input?: string | null): string | null {
  const trimmed = input?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 256) throw new Error("Idempotency key too long");
  return trimmed;
}

export function normalizeUuidEventId(input?: string | null, seed?: string): string {
  if (input?.trim()) {
    const id = input.trim();
    if (!UUID_RE.test(id)) throw new Error("Event id must be a valid UUID");
    return id;
  }
  if (!seed?.trim()) throw new Error("Event id or seed required");
  return deterministicEventId(seed.trim());
}

export type IdempotentReplayResponse<T> = T & {
  duplicate?: boolean;
  alreadyProcessed?: boolean;
};

/** Stable payment idempotency when client omits an explicit key. */
export function invoicePaymentIdempotencyKey(
  organizationId: string,
  documentId: string,
  paymentDate: string,
  amount: number,
  clientKey?: string | null,
): string {
  const normalized = normalizeIdempotencyKey(clientKey);
  if (normalized) return normalized;
  return deterministicEventId(
    `invoice-pay:${organizationId}:${documentId}:${paymentDate.slice(0, 10)}:${amount.toFixed(2)}`,
  );
}

export function billPaymentIdempotencyKey(
  organizationId: string,
  partyId: string,
  paymentDate: string,
  total: number,
  allocationDocumentIds: string[],
  clientKey?: string | null,
): string {
  const normalized = normalizeIdempotencyKey(clientKey);
  if (normalized) return normalized;
  const billKey = [...allocationDocumentIds].sort().join(",");
  return deterministicEventId(
    `bill-pay:${organizationId}:${partyId}:${paymentDate.slice(0, 10)}:${total.toFixed(2)}:${billKey}`,
  );
}

export function bankingOperationSeed(
  operation: string,
  organizationId: string,
  bankTransactionId: string,
  extra?: string,
): string {
  return `bank:${operation}:${organizationId}:${bankTransactionId}${extra ? `:${extra}` : ""}`;
}
