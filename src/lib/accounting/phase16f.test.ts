/**
 * Phase 16F design tests — consolidated reporting (no production DB).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  consolidationAccountKey,
  isIntercompanyAccount,
  mergeContributions,
} from "./consolidated/grouping";

const root = process.cwd();

function read(rel: string) {
  return readFileSync(resolve(root, rel), "utf8");
}

describe("Phase 16F consolidated reporting design", () => {
  it("consolidation modules exist", () => {
    for (const file of [
      "src/lib/accounting/consolidated/types.ts",
      "src/lib/accounting/consolidated/scope.ts",
      "src/lib/accounting/consolidated/grouping.ts",
      "src/lib/accounting/consolidated/trial-balance.ts",
      "src/lib/accounting/consolidated/profit-loss.ts",
      "src/lib/accounting/consolidated/balance-sheet.ts",
      "src/lib/accounting/consolidated/cash-flow.ts",
      "src/app/api/reports/consolidated/trial-balance/route.ts",
      "src/app/api/reports/consolidated/profit-loss/route.ts",
      "src/app/api/reports/consolidated/balance-sheet/route.ts",
      "src/app/api/reports/consolidated/cash-flow/route.ts",
      "src/app/app/reports/consolidated/page.tsx",
    ]) {
      expect(existsSync(resolve(root, file)), file).toBe(true);
    }
  });

  it("groups accounts by type, subtype, code, and normalized name", () => {
    const revenueA = consolidationAccountKey({
      type: "revenue",
      subtype: "service",
      code: "4100",
      name: "Service Revenue",
    });
    const revenueDifferentSubtype = consolidationAccountKey({
      type: "revenue",
      subtype: "other",
      code: "4100",
      name: "Service Revenue",
    });
    const expenseSameCode = consolidationAccountKey({
      type: "expense",
      subtype: "service",
      code: "4100",
      name: "Service Revenue",
    });
    const unrelatedSameClassification = consolidationAccountKey({
      type: "revenue",
      subtype: "service",
      code: "4100",
      name: "HVAC Service Revenue",
    });
    const equivalentCopy = consolidationAccountKey({
      type: "revenue",
      subtype: "service",
      code: "4100",
      name: "service revenue",
    });
    expect(revenueA).not.toBe(expenseSameCode);
    expect(revenueA).not.toBe(revenueDifferentSubtype);
    expect(revenueA).not.toBe(unrelatedSameClassification);
    expect(revenueA).toBe(equivalentCopy);
  });

  it("detects intercompany account subtypes", () => {
    expect(isIntercompanyAccount({ subtype: "due_from" })).toBe(true);
    expect(isIntercompanyAccount({ subtype: "due_to" })).toBe(true);
    expect(isIntercompanyAccount({ subtype: "bank" })).toBe(false);
  });

  it("merges entity contributions by legal entity", () => {
    const merged = mergeContributions(
      [{ legalEntityId: "a", entityName: "A", entityCode: "A", amount: 100 }],
      { legalEntityId: "a", entityName: "A", entityCode: "A", amount: 50 },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.amount).toBe(150);
  });

  it("consolidated reporting is query-only (no journal posting)", () => {
    const files = [
      "src/lib/accounting/consolidated/trial-balance.ts",
      "src/lib/accounting/consolidated/profit-loss.ts",
      "src/lib/accounting/consolidated/balance-sheet.ts",
      "src/lib/accounting/consolidated/cash-flow.ts",
    ];
    for (const file of files) {
      const source = read(file);
      expect(source).not.toMatch(/\.insert\(/);
      expect(source).not.toMatch(/\.update\(/);
      expect(source).not.toMatch(/teller_atomic_post/);
      expect(source).not.toMatch(/elimination/i);
    }
  });

  it("scope resolver enforces entity access server-side", () => {
    const scope = read("src/lib/accounting/consolidated/scope.ts");
    expect(scope).toMatch(/assertEntityAccess/);
    expect(scope).toMatch(/includeAllEntities/);
  });

  it("no migration 046 required for consolidated scope tables", () => {
    expect(existsSync(resolve(root, "supabase/migrations/046_phase16f_consolidated_reporting.sql"))).toBe(
      false,
    );
  });

  it("UI labels pre-elimination consolidated reports", () => {
    const ui = read("src/components/ConsolidatedReportsView.tsx");
    expect(ui).toMatch(/Pre-elimination/i);
    expect(ui).toMatch(/All Companies/);
  });
});
