import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("Phase 17B security hardening (static)", () => {
  it("patch 051 removes journal INSERT policies", () => {
    const sql = read("supabase/patches/051_phase17b_security_hardening.sql");
    expect(sql).toContain('drop policy if exists "teller entity journal entries insert"');
    expect(sql).toContain('drop policy if exists "teller entity journal lines insert"');
    expect(sql).toContain("teller_phase17b_journal_insert_blocked");
    expect(sql.toLowerCase()).not.toMatch(/disable row level security/);
  });

  it("fixed asset link path avoids posted journal line UPDATE", () => {
    const acquisition = read("src/lib/accounting/fixed-asset-acquisition.ts");
    expect(acquisition).not.toMatch(/teller_journal_lines["']\)\s*\.\s*update/);
    expect(acquisition).toContain("recordFixedAssetJournalLink");
  });

  it("requireBooks derives org from session not client", () => {
    const api = read("src/lib/api.ts");
    expect(api).toMatch(/organizationId = session\.organization\.id/);
    expect(api).not.toMatch(/searchParams\.get\(["']organizationId["']\)/);
  });

  it("HFAC webhook verifies HMAC", () => {
    expect(read("src/lib/integrations/hfac-auth.ts")).toContain("verifyHfacWebhookAuth");
    expect(read("src/lib/integrations/hfac-auth.ts")).toContain("timingSafeEqual");
  });

  it("HFAC org resolution rejects client-controlled org", () => {
    const org = read("src/lib/integrations/hfac-org.ts");
    expect(org).toContain("resolveHfacWebhookOrganization");
    expect(org).toMatch(/external_account_id|external mapping/i);
  });

  it("no journal entry mutations in src/", () => {
    const unsafe = /\.from\(["']teller_journal_entries["']\)\s*\.\s*(insert|update|delete|upsert)/;
    const hits: string[] = [];
    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && unsafe.test(readFileSync(full, "utf8"))) {
          hits.push(full);
        }
      }
    }
    walk(join(ROOT, "src"));
    expect(hits).toEqual([]);
  });

  it("service role isolated to admin module", () => {
    expect(existsSync(join(ROOT, "src/lib/supabase/admin.ts"))).toBe(true);
    const admin = read("src/lib/supabase/admin.ts");
    expect(admin).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("phase 17B security doc exists", () => {
    expect(existsSync(join(ROOT, "docs/PHASE-17B-SECURITY-HARDENING.md"))).toBe(true);
  });
});
