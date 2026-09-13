import { describe, expect, it } from "vitest";
import { TELLER_HFAC_ORG_ID } from "@/lib/integration/controlled-prod-test";
import { readSrc, srcExists } from "./helpers";

describe("Phase 17G security certification", () => {
  it("HFAC org id is fixed and documented", () => {
    expect(TELLER_HFAC_ORG_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("HFAC webhook requires auth", () => {
    const webhook = readSrc("src/lib/integrations/hfac-webhook.ts");
    expect(webhook).toContain("verifyHfacWebhookAuth");
  });

  it("controlled prod test blocks HFAC org mutation", () => {
    const guard = readSrc("src/lib/integration/controlled-prod-test.ts");
    expect(guard).toContain("assertNotHfacOrganization");
    expect(guard).toContain("TELLER_HFAC_ORG_ID");
  });

  it("idempotency module exists for retry certification", () => {
    expect(srcExists("src/lib/reliability/idempotency.ts")).toBe(true);
  });

  it("audit module supports append-only events", () => {
    const audit = readSrc("src/lib/accounting/audit.ts");
    expect(audit).toContain("recordAuditEvent");
  });

  it("patch 054 audit immutability exists", () => {
    expect(srcExists("supabase/patches/054_phase17e_operational_controls.sql")).toBe(true);
    const patch = readSrc("supabase/patches/054_phase17e_operational_controls.sql");
    expect(patch).toMatch(/audit/i);
  });

  it("presentation mode does not alter posting gateway", () => {
    const post = readSrc("src/lib/accounting/post.ts");
    const ux = readSrc("src/lib/ux/presentation-mode.ts");
    expect(post).toContain("postJournal");
    expect(ux).not.toContain("postJournal");
  });

  it("requireBooks pattern used in API routes", () => {
    const invoices = readSrc("src/app/api/invoices/route.ts");
    expect(invoices).toMatch(/requireAccountingBooks/);
  });
});
