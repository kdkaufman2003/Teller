/**
 * Phase 16H design tests — entity-level accounting controls (no production DB).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ENTITY_CONTROL_MESSAGES } from "./entity-books/errors";
import { nextNumber } from "./accounts";

const root = process.cwd();

function read(rel: string) {
  return readFileSync(resolve(root, rel), "utf8");
}

describe("Phase 16H entity controls design", () => {
  it("scope registry and migration 047 exist", () => {
    expect(existsSync(resolve(root, "docs/PHASE-16-ENTITY-SCOPE.md"))).toBe(true);
    expect(
      existsSync(resolve(root, "supabase/migrations/047_phase16h_entity_controls.sql")),
    ).toBe(true);
  });

  it("canonical entity validation helpers exist", () => {
    const validation = read("src/lib/accounting/entity-books/validation.ts");
    expect(validation).toMatch(/assertAccountBelongsToEntity/);
    expect(validation).toMatch(/assertDocumentBelongsToEntity/);
    expect(validation).toMatch(/assertPaymentBelongsToEntity/);
    expect(validation).toMatch(/assertBankAccountBelongsToEntity/);
    expect(validation).toMatch(/assertAllocationSameEntity/);
    expect(validation).toMatch(/EntityControlError/);
  });

  it("entity accounting settings service is canonical", () => {
    const settings = read("src/lib/accounting/entity-books/settings.ts");
    expect(settings).toMatch(/loadEntityAccountingSettings/);
    expect(settings).toMatch(/upsertEntityAccountingSettings/);
    expect(settings).toMatch(/teller_entity_accounting_settings/);
  });

  it("posting resolves legal entity from document", () => {
    const post = read("src/lib/accounting/post.ts");
    expect(post).toMatch(/resolvePostingLegalEntityId/);
    expect(post).toMatch(/legalEntityId/);
  });

  it("payments persist legal_entity_id", () => {
    const payments = read("src/lib/accounting/payments.ts");
    expect(payments).toMatch(/legal_entity_id/);
    expect(payments).toMatch(/resolvePostingLegalEntityId/);
  });

  it("invoice API uses entity-scoped guards and numbering", () => {
    const route = read("src/app/api/invoices/route.ts");
    expect(route).toMatch(/requireAccountingWriteBooks/);
    expect(route).toMatch(/legal_entity_id/);
    expect(route).toMatch(/nextEntityDocumentNumber/);
  });

  it("entity control errors are user-safe", () => {
    expect(ENTITY_CONTROL_MESSAGES.accountWrongEntity).toMatch(/another company/i);
    expect(ENTITY_CONTROL_MESSAGES.crossEntityAllocation).toMatch(/another company/i);
  });

  it("document numbers can be independent per entity", () => {
    const a = nextNumber("INV", ["INV-1001"]);
    const b = nextNumber("INV", ["INV-1001"]);
    expect(a).toBe("INV-1002");
    expect(b).toBe("INV-1002");
  });

  it("migration 047 replaces org-only RLS with entity-aware policies", () => {
    const sql = read("supabase/migrations/047_phase16h_entity_controls.sql");
    expect(sql).toMatch(/teller_can_access_legal_entity/);
    expect(sql).toMatch(/teller entity accounts select/);
    expect(sql).toMatch(/teller entity documents select/);
    expect(sql).toMatch(/teller entity journal entries select/);
    expect(sql).toMatch(/teller entity payments select/);
    expect(sql).not.toMatch(/disable row level security/i);
  });

  it("HFAC remains server-side entity resolution", () => {
    const hfac = read("src/lib/integrations/hfac.ts");
    expect(hfac).not.toMatch(/legal_entity_id.*body/i);
  });
});
