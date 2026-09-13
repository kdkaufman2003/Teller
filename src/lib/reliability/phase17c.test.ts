import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  bankingOperationSeed,
  billPaymentIdempotencyKey,
  deterministicEventId,
  invoicePaymentIdempotencyKey,
  normalizeIdempotencyKey,
  normalizeUuidEventId,
} from "./idempotency";

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("Phase 17C reliability (static + semantics)", () => {
  it("patch 052 exists with idempotency and capacity guards", () => {
    const sql = read("supabase/patches/052_phase17c_reliability_hardening.sql");
    expect(sql).toContain("idempotency_key");
    expect(sql).toContain("teller_payment_allocation_capacity_check");
    expect(sql).toContain("teller_phase17c_reliability_probe");
    expect(sql.toLowerCase()).not.toMatch(/disable row level security/);
  });

  it("static verifier for patch 052 exists", () => {
    expect(existsSync(join(ROOT, "scripts/verify-migration-052-static.mjs"))).toBe(true);
  });

  it("idempotency helpers produce stable keys", () => {
    const seed = "invoice-pay:org:doc:2026-01-01:100.00";
    expect(deterministicEventId(seed)).toBe(deterministicEventId(seed));
    expect(normalizeUuidEventId(undefined, seed)).toBe(deterministicEventId(seed));
  });

  it("invoice payment idempotency uses client key when provided", () => {
    expect(
      invoicePaymentIdempotencyKey("org", "doc", "2026-01-01", 50, "client-key-1"),
    ).toBe("client-key-1");
  });

  it("bill payment idempotency is deterministic without client key", () => {
    const a = billPaymentIdempotencyKey("org", "party", "2026-01-01", 100, ["b1", "b2"]);
    const b = billPaymentIdempotencyKey("org", "party", "2026-01-01", 100, ["b2", "b1"]);
    expect(a).toBe(b);
  });

  it("banking operation seed is stable", () => {
    expect(bankingOperationSeed("categorize", "org", "txn", "expense")).toBe(
      "bank:categorize:org:txn:expense",
    );
  });

  it("normalizeIdempotencyKey rejects overlong keys", () => {
    expect(() => normalizeIdempotencyKey("x".repeat(300))).toThrow(/too long/);
  });

  it("postInvoicePaid wires idempotency pre-check", () => {
    const post = read("src/lib/accounting/post.ts");
    expect(post).toContain("invoicePaymentIdempotencyKey");
    expect(post).toMatch(/idempotency_key/);
  });

  it("postMultiBillPayment persists idempotency_key column", () => {
    const billPay = read("src/lib/accounting/bill-pay.ts");
    expect(billPay).toContain("billPaymentIdempotencyKey");
    expect(billPay).toContain("idempotencyKey: resolvedIdempotencyKey");
  });

  it("HFAC webhook uses claim/process lifecycle", () => {
    const hfac = read("src/lib/integrations/hfac-webhook.ts");
    expect(hfac).toContain("claimHfacWebhookEvent");
    expect(hfac).toContain("markHfacWebhookProcessed");
    expect(hfac).toContain("markHfacWebhookFailed");
    expect(hfac).toContain("duplicate_processed");
  });

  it("banking categorize uses deterministic seed fallback", () => {
    const categorize = read("src/lib/banking/categorize.ts");
    expect(categorize).toContain("bankingOperationSeed");
  });

  it("schedule occurrence posting uses atomic claim", () => {
    const schedules = read("src/lib/accounting/schedules/process-due.ts");
    expect(schedules).toMatch(/\.is\("journal_entry_id", null\)/);
    expect(schedules).toContain("postScheduleOccurrence");
  });

  it("phase 17C reliability doc exists", () => {
    expect(existsSync(join(ROOT, "docs/PHASE-17C-RELIABILITY.md"))).toBe(true);
  });

  it("production verify script exists", () => {
    expect(existsSync(join(ROOT, "scripts/verify-phase17c-production.mjs"))).toBe(true);
  });

  it("controlled acceptance runner exists", () => {
    expect(existsSync(join(ROOT, "scripts/run-controlled-phase17c-reliability-acceptance.mjs"))).toBe(
      true,
    );
  });
});
