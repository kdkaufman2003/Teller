/**
 * Phase 16G design tests — consolidation eliminations (no production DB).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildConsolidationScopeKey } from "./consolidated/eliminations/scope-key";
import {
  applyEliminationsToTrialBalanceRows,
  applyEliminationsToFinancialLines,
} from "./consolidated/eliminations/apply";
import { sumEliminationAdjustmentsByGroupKey } from "./consolidated/eliminations/load-posted";
import { consolidationAccountKey } from "./consolidated/grouping";

const root = process.cwd();

function read(rel: string) {
  return readFileSync(resolve(root, rel), "utf8");
}

describe("Phase 16G consolidation eliminations design", () => {
  it("elimination modules exist", () => {
    for (const file of [
      "supabase/migrations/046_phase16g_consolidation_eliminations.sql",
      "src/lib/accounting/consolidated/eliminations/service.ts",
      "src/lib/accounting/consolidated/eliminations/suggestions-due-to-from.ts",
      "src/lib/accounting/consolidated/eliminations/worksheet.ts",
      "src/app/api/reports/consolidated/eliminations/route.ts",
      "scripts/verify-phase16g-eliminations.mjs",
    ]) {
      expect(existsSync(resolve(root, file)), file).toBe(true);
    }
  });

  it("builds deterministic consolidation scope keys", () => {
    const orgId = "11111111-1111-1111-1111-111111111111";
    const a = buildConsolidationScopeKey(orgId, ["b", "a"]);
    const b = buildConsolidationScopeKey(orgId, ["a", "b"]);
    const c = buildConsolidationScopeKey(orgId, ["a", "b", "c"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("applies balanced elimination adjustments to trial balance rows", () => {
    const groupKey = consolidationAccountKey({
      type: "asset",
      subtype: "due_from",
      code: "1250",
      name: "Due From Related Entity",
    });
    const preRows = [
      {
        groupKey,
        code: "1250",
        name: "Due From Related Entity",
        type: "asset",
        subtype: "due_from",
        adjustedDebit: 10000,
        adjustedCredit: 0,
        netBalance: 10000,
        isIntercompany: true,
        entityContributions: [],
      },
    ];
    const adjustments = [
      {
        entryId: "e1",
        effectiveDate: "2026-08-31",
        periodStart: null,
        periodEnd: "2026-08-31",
        entryType: "due_to_due_from",
        reversesEntryId: null,
        lines: [
          {
            id: "l1",
            lineNumber: 1,
            groupKey,
            accountType: "asset",
            accountSubtype: "due_from",
            accountCode: "1250",
            accountName: "Due From Related Entity",
            sourceLegalEntityId: null,
            sourceAccountId: null,
            debit: 0,
            credit: 10000,
            memo: "",
          },
        ],
      },
    ];
    const applied = applyEliminationsToTrialBalanceRows(preRows, adjustments);
    expect(applied.rows[0]?.netBalance).toBe(0);
    expect(applied.rows[0]?.adjustedCredit).toBe(10000);
  });

  it("applies elimination deltas to financial lines by account type", () => {
    const groupKey = consolidationAccountKey({
      type: "revenue",
      subtype: "service",
      code: "4900",
      name: "Intercompany Revenue",
    });
    const preLines = [
      {
        groupKey,
        code: "4900",
        name: "Intercompany Revenue",
        amount: 5000,
        isIntercompany: true,
        entityContributions: [],
      },
    ];
    const adjustments = [
      {
        entryId: "e1",
        effectiveDate: "2026-08-31",
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        entryType: "intercompany_pl",
        reversesEntryId: null,
        lines: [
          {
            id: "l1",
            lineNumber: 1,
            groupKey,
            accountType: "revenue",
            accountSubtype: "service",
            accountCode: "4900",
            accountName: "Intercompany Revenue",
            sourceLegalEntityId: null,
            sourceAccountId: null,
            debit: 5000,
            credit: 0,
            memo: "",
          },
        ],
      },
    ];
    const postLines = applyEliminationsToFinancialLines(preLines, adjustments);
    expect(postLines).toHaveLength(0);
  });

  it("sums elimination adjustments by group key", () => {
    const totals = sumEliminationAdjustmentsByGroupKey([
      {
        entryId: "e1",
        effectiveDate: "2026-08-31",
        periodStart: null,
        periodEnd: "2026-08-31",
        entryType: "manual",
        reversesEntryId: null,
        lines: [
          {
            id: "l1",
            lineNumber: 1,
            groupKey: "asset|due_from|1250|due from",
            accountType: "asset",
            accountSubtype: "due_from",
            accountCode: "1250",
            accountName: "Due From",
            sourceLegalEntityId: null,
            sourceAccountId: null,
            debit: 0,
            credit: 9500,
            memo: "",
          },
        ],
      },
    ]);
    expect(totals.get("asset|due_from|1250|due from")?.credit).toBe(9500);
  });

  it("elimination service does not post to legal-entity journals", () => {
    const service = read("src/lib/accounting/consolidated/eliminations/service.ts");
    expect(service).toMatch(/teller_atomic_post_consolidation_elimination/);
    expect(service).not.toMatch(/teller_post_journal/);
    expect(service).not.toMatch(/teller_journal_entries/);
  });

  it("suggestion engines remain read-only", () => {
    for (const file of [
      "src/lib/accounting/consolidated/eliminations/suggestions.ts",
      "src/lib/accounting/consolidated/eliminations/suggestions-due-to-from.ts",
      "src/lib/accounting/consolidated/eliminations/suggestions-pl.ts",
    ]) {
      const source = read(file);
      expect(source).not.toMatch(/\.insert\(/);
      expect(source).not.toMatch(/\.update\(/);
      expect(source).not.toMatch(/teller_atomic_post/);
    }
  });

  it("due-to/from suggestions use matched amount only", () => {
    const source = read("src/lib/accounting/consolidated/eliminations/suggestions-due-to-from.ts");
    expect(source).toMatch(/Math\.min/);
    expect(source).toMatch(/difference/);
    expect(source).toMatch(/getIntercompanyPairReconciliation/);
  });

  it("migration 046 is prepared but not auto-applied", () => {
    expect(existsSync(resolve(root, "supabase/migrations/046_phase16g_consolidation_eliminations.sql"))).toBe(
      true,
    );
    expect(existsSync(resolve(root, "supabase/migrations/046_phase16f_consolidated_reporting.sql"))).toBe(
      false,
    );
  });
});
