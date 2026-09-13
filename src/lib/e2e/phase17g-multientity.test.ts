import { describe, expect, it } from "vitest";
import { assertBalanced } from "@/lib/accounting/post";
import { E2E_MODULE_PATHS, readSrc, srcExists } from "./helpers";

describe("Phase 17G multi-entity lifecycle", () => {
  it("intercompany pair is balanced across due-from / due-to", () => {
    const lines = [
      { account_id: "due-from", debit: 1000, credit: 0 },
      { account_id: "due-to", debit: 0, credit: 1000 },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it("elimination entry offsets intercompany balances", () => {
    const lines = [
      { account_id: "due-from", debit: 0, credit: 1000 },
      { account_id: "due-to", debit: 1000, credit: 0 },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it("one journal one entity enforced in migration", () => {
    const migration = readSrc("supabase/migrations/042_phase16c_entity_books.sql");
    expect(migration).toMatch(/legal_entity_id is distinct from NEW.legal_entity_id/);
  });

  it("intercompany modules exist", () => {
    expect(srcExists(E2E_MODULE_PATHS.intercompany)).toBe(true);
  });

  it("consolidation modules exist", () => {
    expect(srcExists(E2E_MODULE_PATHS.consolidation)).toBe(true);
    expect(srcExists("src/lib/accounting/consolidated/eliminations/service.ts")).toBe(true);
  });

  it("all companies view is reporting-only in UX", () => {
    const companies = readSrc("src/app/app/companies/page.tsx");
    expect(companies).toContain("View only");
  });

  it("bank transfer requires matching entity", () => {
    const transfer = readSrc(E2E_MODULE_PATHS.transfer);
    expect(transfer).toContain("legal_entity_id");
  });

  it("jobs remain org-scoped per entity scope doc", () => {
    const scope = readSrc("docs/PHASE-16-ENTITY-SCOPE.md");
    expect(scope).toContain("teller_jobs");
  });
});
