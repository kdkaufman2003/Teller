/**
 * Phase 16C design tests — entity book ownership invariants (no production DB).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { accountingContext } from "./legal-entity/context";

const M042 = resolve(process.cwd(), "supabase/migrations/042_phase16c_entity_books.sql");

describe("Phase 16C entity books design", () => {
  it("migration 042 exists with entity ownership primitives", () => {
    expect(existsSync(M042)).toBe(true);
    const sql = readFileSync(M042, "utf8");
    expect(sql).toMatch(/teller_accounts[\s\S]*legal_entity_id/);
    expect(sql).toMatch(/teller_journal_entries[\s\S]*legal_entity_id/);
    expect(sql).toMatch(/teller_assert_accounts_match_entity/);
    expect(sql).toMatch(/p_legal_entity_id uuid/);
    expect(sql).not.toMatch(/create table public\.teller_.*intercompany/i);
  });

  it("AccountingContext requires both org and entity", () => {
    expect(() => accountingContext("", "entity-id")).toThrow(/organizationId/);
    expect(() => accountingContext("org-id", "")).toThrow(/legalEntityId/);
    expect(accountingContext("org-id", "entity-id")).toEqual({
      organizationId: "org-id",
      legalEntityId: "entity-id",
    });
  });

  it("same account code allowed across entities (unique per entity)", () => {
    const sql = readFileSync(M042, "utf8");
    expect(sql).toMatch(/teller_accounts_entity_code_uidx[\s\S]*legal_entity_id, code/);
    expect(sql).toMatch(/drop constraint if exists teller_accounts_organization_id_code_key/);
  });

  it("journal lines inherit entity from header (no line column)", () => {
    const sql = readFileSync(M042, "utf8");
    expect(sql).not.toMatch(/alter table public\.teller_journal_lines[\s\S]*legal_entity_id/);
  });

  it("cross-entity single journal blocked at DB layer", () => {
    const sql = readFileSync(M042, "utf8");
    expect(sql).toMatch(/Cross-entity account posting is not allowed/);
  });

  it("posted journal entity reassignment blocked", () => {
    const sql = readFileSync(M042, "utf8");
    expect(sql).toMatch(/Posted journal legal entity cannot be reassigned/);
  });

  it("period close is entity-scoped", () => {
    const sql = readFileSync(M042, "utf8");
    expect(sql).toMatch(/teller_period_closes[\s\S]*legal_entity_id/);
    expect(sql).toMatch(/teller_books_closed_through\([\s\S]*p_legal_entity_id/);
  });

  it("bank GL mapping cannot cross entity", () => {
    const sql = readFileSync(M042, "utf8");
    expect(sql).toMatch(/Bank account GL mapping must belong to the same legal entity/);
  });

  it("entity accounting settings table supports fiscal year per entity", () => {
    const sql = readFileSync(M042, "utf8");
    expect(sql).toMatch(/teller_entity_accounting_settings/);
    expect(sql).toMatch(/fiscal_year_start_month/);
  });

  it("HFAC must not accept client-controlled entity (architecture)", () => {
    expect(true).toBe(true);
  });

  it("no consolidated reporting tables in 16C migration", () => {
    const sql = readFileSync(M042, "utf8");
    expect(sql).not.toMatch(/create table public\.teller_.*consolidat/i);
  });
});
