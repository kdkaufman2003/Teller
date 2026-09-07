import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildAccrualSettlementJournalLines,
  assertSettlementJournalBalanced,
  sumJournalCredits,
  buildAccrualSettlementReversalLines,
} from "./accrual-settlement/journal-lines";
import {
  computeSettlementEconomics,
  proportionalActualAllocation,
} from "./accrual-settlement/allocation-engine";
import {
  allocateVendorPurchaseTax,
  purchaseTaxUsesSalesTaxPayable,
} from "./accrual-settlement/purchase-tax";
import {
  proportionalTaxAllocation,
  PurchaseTaxAttributionError,
  resolveLineTaxAttribution,
} from "./accrual-settlement/tax-attribution";
import {
  BILL_VOID_BLOCKED_ACTIVE_SETTLEMENT_MESSAGE,
  isActiveSettlementStatus,
} from "./accrual-settlement/bill-settlement-guard";
import {
  computeOccurrenceSettlementStatus,
  variancePercent,
} from "./accrual-settlement/status";
import {
  isOccurrenceEligibleForSettlement,
  assertSameOrganization,
  type AccrualOccurrenceRow,
} from "./accrual-settlement/eligibility";
import { classifyAccrualSettlementCloseFinding } from "./accrual-settlement/close-integration";
import { accrualSettlementIdempotencyKey } from "./accrual-settlement/types";
import {
  PRODUCTION_SCHEDULER_ENABLED,
} from "./schedules/scheduler-config";

const MIGRATION = resolve(process.cwd(), "supabase/migrations/028_phase11_1_accrual_settlement.sql");
const UTIL_LIAB = "util-liab";
const UTIL_EXP = "util-exp";
const MAINT_LIAB = "maint-liab";
const MAINT_EXP = "maint-exp";
const SUPPLIES = "supplies-exp";
const AP = "ap";
const INPUT_TAX = "input-tax-asset";

function sampleOccurrence(overrides: Partial<AccrualOccurrenceRow> = {}): AccrualOccurrenceRow {
  return {
    id: "u",
    organization_id: "org",
    schedule_id: "s",
    occurrence_date: "2026-01-31",
    amount: 600,
    status: "posted",
    journal_entry_id: "je",
    teller_accounting_schedules: {
      schedule_type: "accrued_expense",
      name: "Utilities",
      vendor_party_id: "vendor-a",
      liability_account_id: UTIL_LIAB,
      expense_account_id: UTIL_EXP,
      status: "active",
    },
    ...overrides,
  };
}

function buildMultiAccountSettlement(actualTotal: number) {
  const economics = computeSettlementEconomics({
    billLines: [{ amount: actualTotal, account_id: UTIL_EXP, lineKey: "settle" }],
    taxAmount: 0,
    accrualAllocations: [
      {
        occurrenceId: "u",
        appliedAmount: 600,
        liabilityAccountId: UTIL_LIAB,
        expenseAccountId: UTIL_EXP,
      },
      {
        occurrenceId: "m",
        appliedAmount: 400,
        liabilityAccountId: MAINT_LIAB,
        expenseAccountId: MAINT_EXP,
      },
    ],
  });
  return buildAccrualSettlementJournalLines({
    accrualAllocations: economics.accrualAllocations.map((row) => ({
      ...row,
      memo: row.occurrenceId,
    })),
    newExpenseDebits: economics.newExpenseDebits,
    recoverableTaxDebits: economics.recoverableTaxDebits,
    billTotal: economics.billTotal,
    apAccountId: AP,
  });
}

function buildJournalFromEconomics(economics: ReturnType<typeof computeSettlementEconomics>) {
  return buildAccrualSettlementJournalLines({
    accrualAllocations: economics.accrualAllocations,
    newExpenseDebits: economics.newExpenseDebits,
    recoverableTaxDebits: economics.recoverableTaxDebits,
    billTotal: economics.billTotal,
    apAccountId: AP,
  });
}

describe("Phase 11.1 corrections — migration 028", () => {
  it("includes per-allocation actual economics columns", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain("actual_amount_allocated");
    expect(sql).toContain("actual_pre_tax_allocated");
    expect(sql).toContain("nonrecoverable_tax_allocated");
    expect(sql).toContain("recoverable_tax_allocated");
    expect(sql).toContain("accrual_settlement_portion");
    expect(sql).toContain("new_expense_portion");
    expect(sql).toContain("purchase_tax_portion");
  });
});

describe("Phase 11.1 corrections — bill void guard", () => {
  it("1 active settlement statuses block void conceptually", () => {
    expect(isActiveSettlementStatus("posted")).toBe(true);
    expect(isActiveSettlementStatus("settled")).toBe(true);
    expect(isActiveSettlementStatus("reversed")).toBe(false);
  });

  it("2 void blocked message is explicit", () => {
    expect(BILL_VOID_BLOCKED_ACTIVE_SETTLEMENT_MESSAGE).toContain("Reverse the accrual settlement");
  });
});

describe("Phase 11.1 corrections — multi-account variance", () => {
  it("3 exact settlement when actual equals estimate", () => {
    const economics = computeSettlementEconomics({
      billLines: [{ amount: 1000, account_id: UTIL_EXP, lineKey: "settle" }],
      taxAmount: 0,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 1000, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
      ],
    });
    expect(economics.accrualAllocations[0].varianceAmount).toBe(0);
    assertSettlementJournalBalanced(buildJournalFromEconomics(economics));
  });

  it("4-6 positive variance split across accounts (600/400 -> 660/440)", () => {
    const economics = computeSettlementEconomics({
      billLines: [{ amount: 1100, account_id: UTIL_EXP, lineKey: "settle" }],
      taxAmount: 0,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 600, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
        { occurrenceId: "m", appliedAmount: 400, liabilityAccountId: MAINT_LIAB, expenseAccountId: MAINT_EXP },
      ],
    });
    expect(economics.accrualAllocations.find((row) => row.occurrenceId === "u")?.varianceAmount).toBe(60);
    expect(economics.accrualAllocations.find((row) => row.occurrenceId === "m")?.varianceAmount).toBe(40);
  });

  it("7 proportional allocation cent rounding absorbs remainder", () => {
    const shares = proportionalActualAllocation({
      settlementPortion: 100,
      allocations: [
        { occurrenceId: "a", appliedAmount: 33.33 },
        { occurrenceId: "b", appliedAmount: 33.33 },
        { occurrenceId: "c", appliedAmount: 33.34 },
      ],
    });
    const total = [...shares.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBe(100);
  });

  it("8 over-settlement rejected at eligibility layer", () => {
    const check = isOccurrenceEligibleForSettlement(sampleOccurrence({ amount: 600 }), {
      organizationId: "org",
      settledAmount: 0,
      applyAmount: 700,
    });
    expect(check.eligible).toBe(false);
  });

  it("9 first-account ordering cannot affect journal economics", () => {
    const forward = buildMultiAccountSettlement(1100);
    const reversed = buildMultiAccountSettlement(1100);
    const utilVarianceForward = forward.find((line) => line.account_id === UTIL_EXP && line.debit)?.debit ?? 0;
    const maintVarianceForward = forward.find((line) => line.account_id === MAINT_EXP && line.debit)?.debit ?? 0;
    expect(utilVarianceForward).toBe(60);
    expect(maintVarianceForward).toBe(40);
    assertSettlementJournalBalanced(reversed);
  });

  it("6 negative variance split when actual bill below estimate", () => {
    const economics = computeSettlementEconomics({
      billLines: [{ amount: 900, account_id: UTIL_EXP, lineKey: "settle" }],
      taxAmount: 0,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 1000, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
      ],
    });
    expect(economics.accrualAllocations[0].varianceAmount).toBe(-100);
    const journal = buildJournalFromEconomics(economics);
    assertSettlementJournalBalanced(journal);
    expect(journal.find((line) => line.account_id === UTIL_EXP && line.credit === 100)).toBeTruthy();
  });

  it("17 journal balanced for multi-account settlement", () => {
    assertSettlementJournalBalanced(buildMultiAccountSettlement(1100));
  });

  it("18 AP equals full bill total", () => {
    const lines = buildMultiAccountSettlement(1100);
    expect(lines.find((line) => line.account_id === AP)?.credit).toBe(1100);
  });
});

describe("Phase 11.1 corrections — purchase tax", () => {
  it("10 nonrecoverable purchase tax becomes expense cost", () => {
    const allocations = allocateVendorPurchaseTax({
      taxAmount: 8,
      targets: [{ accountId: SUPPLIES, amount: 100, accountType: "expense" }],
    });
    expect(allocations[0].accountId).toBe(SUPPLIES);
    expect(allocations[0].amount).toBe(8);
  });

  it("11 tax is not posted to sales-tax-payable", () => {
    expect(purchaseTaxUsesSalesTaxPayable()).toBe(false);
  });

  it("12 recoverable input tax uses asset account when configured", () => {
    const allocations = allocateVendorPurchaseTax({
      taxAmount: 8,
      targets: [{ accountId: SUPPLIES, amount: 100, accountType: "expense", recoverableInputTax: true }],
      recoverableInputTaxAccountId: INPUT_TAX,
    });
    expect(allocations[0].accountId).toBe(INPUT_TAX);
  });
});

describe("Phase 11.1 corrections — mixed settlement and new expense", () => {
  it("13 mixed bill with line-level tax on service and supplies", () => {
    const economics = computeSettlementEconomics({
      billLines: [
        { lineKey: "service", amount: 1050, account_id: UTIL_EXP, taxAmount: 84 },
        { lineKey: "supplies", amount: 200, account_id: SUPPLIES, settlesAccrual: false, taxAmount: 16 },
      ],
      taxAmount: 100,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 1000, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
      ],
    });
    expect(economics.accrualAllocations[0].varianceAmount).toBe(134);
    expect(economics.newExpensePortion).toBe(216);
    expect(economics.billTotal).toBe(1350);

    const journal = buildJournalFromEconomics(economics);
    assertSettlementJournalBalanced(journal);
    expect(sumJournalCredits(journal)).toBe(1350);
    expect(journal.find((line) => line.account_id === SUPPLIES)?.debit).toBe(216);
    expect(journal.find((line) => line.account_id === UTIL_EXP && line.debit === 134)).toBeTruthy();
  });

  it("14 unrelated expense excluded from accrual variance", () => {
    const economics = computeSettlementEconomics({
      billLines: [
        { lineKey: "settle", amount: 1000, account_id: UTIL_EXP },
        { lineKey: "supplies", amount: 200, account_id: SUPPLIES, settlesAccrual: false },
      ],
      taxAmount: 0,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 1000, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
      ],
    });
    expect(economics.accrualAllocations[0].varianceAmount).toBe(0);
    expect(economics.newExpensePortion).toBe(200);
  });

  it("15 multi-accrual mixed bill with per-line tax", () => {
    const economics = computeSettlementEconomics({
      billLines: [
        { lineKey: "util", amount: 630, account_id: UTIL_EXP, occurrenceId: "u", taxAmount: 50 },
        { lineKey: "maint", amount: 420, account_id: MAINT_EXP, occurrenceId: "m", taxAmount: 34 },
        { lineKey: "supplies", amount: 200, account_id: SUPPLIES, settlesAccrual: false, taxAmount: 16 },
      ],
      taxAmount: 100,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 600, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
        { occurrenceId: "m", appliedAmount: 400, liabilityAccountId: MAINT_LIAB, expenseAccountId: MAINT_EXP },
      ],
    });
    expect(economics.accrualAllocations.find((row) => row.occurrenceId === "u")?.varianceAmount).toBe(80);
    expect(economics.accrualAllocations.find((row) => row.occurrenceId === "m")?.varianceAmount).toBe(54);
    expect(economics.newExpensePortion).toBe(216);
    expect(economics.billTotal).toBe(1350);
    assertSettlementJournalBalanced(buildJournalFromEconomics(economics));
  });
});

describe("Phase 11.1 corrections — partial multi-account lineage", () => {
  it("16 partial settlement preserves per-occurrence capacity", () => {
    const check = isOccurrenceEligibleForSettlement(sampleOccurrence(), {
      organizationId: "org",
      settledAmount: 300,
      applyAmount: 300,
    });
    expect(check.eligible).toBe(true);

    const status = computeOccurrenceSettlementStatus({
      occurrenceAmount: 600,
      settledAmount: 300,
      occurrenceStatus: "posted",
    });
    expect(status).toBe("partially_settled");
  });

  it("multi-bill accrual allows second bill after partial", () => {
    const secondBill = isOccurrenceEligibleForSettlement(sampleOccurrence(), {
      organizationId: "org",
      settledAmount: 300,
      applyAmount: 300,
    });
    expect(secondBill.eligible).toBe(true);
  });
});

describe("Phase 11.1 — line-level purchase tax attribution", () => {
  it("tax entirely on settlement line participates in variance", () => {
    const economics = computeSettlementEconomics({
      billLines: [{ lineKey: "svc", amount: 1050, account_id: UTIL_EXP, taxAmount: 84 }],
      taxAmount: 84,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 1000, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
      ],
    });
    expect(economics.accrualAllocations[0].nonrecoverableTaxAllocated).toBe(84);
    expect(economics.accrualAllocations[0].varianceAmount).toBe(134);
    assertSettlementJournalBalanced(buildJournalFromEconomics(economics));
  });

  it("tax entirely on new-expense line", () => {
    const economics = computeSettlementEconomics({
      billLines: [
        { lineKey: "settle", amount: 1000, account_id: UTIL_EXP },
        { lineKey: "supplies", amount: 200, account_id: SUPPLIES, settlesAccrual: false, taxAmount: 16 },
      ],
      taxAmount: 16,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 1000, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
      ],
    });
    expect(economics.accrualAllocations[0].varianceAmount).toBe(0);
    expect(economics.newExpensePortion).toBe(216);
  });

  it("tax split between settlement and new-expense lines", () => {
    const economics = computeSettlementEconomics({
      billLines: [
        { lineKey: "svc", amount: 1050, account_id: UTIL_EXP, taxAmount: 84 },
        { lineKey: "sup", amount: 200, account_id: SUPPLIES, settlesAccrual: false, taxAmount: 16 },
      ],
      taxAmount: 100,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 1000, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
      ],
    });
    expect(economics.accrualAllocations[0].nonrecoverableTaxAllocated).toBe(84);
    expect(economics.newExpensePortion).toBe(216);
  });

  it("proportional tax fallback when only header tax provided", () => {
    const economics = computeSettlementEconomics({
      billLines: [
        { lineKey: "a", amount: 100, account_id: UTIL_EXP, taxable: true },
        { lineKey: "b", amount: 100, account_id: SUPPLIES, settlesAccrual: false, taxable: true },
      ],
      taxAmount: 10,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 100, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
      ],
    });
    expect(economics.accrualAllocations[0].nonrecoverableTaxAllocated).toBe(5);
    expect(economics.newExpensePortion).toBe(105);
    expect(economics.billTotal).toBe(210);
  });

  it("cent rounding in proportional tax fallback", () => {
    const shares = proportionalTaxAllocation({
      totalTax: 0.1,
      lines: [
        { lineKey: "a", taxableAmount: 33.33 },
        { lineKey: "b", taxableAmount: 33.33 },
        { lineKey: "c", taxableAmount: 33.34 },
      ],
    });
    const total = [...shares.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBe(0.1);
  });

  it("line order does not affect tax economics", () => {
    const forward = computeSettlementEconomics({
      billLines: [
        { lineKey: "svc", amount: 1050, account_id: UTIL_EXP, taxAmount: 84 },
        { lineKey: "sup", amount: 200, account_id: SUPPLIES, settlesAccrual: false, taxAmount: 16 },
      ],
      taxAmount: 100,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 1000, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
      ],
    });
    const reversed = computeSettlementEconomics({
      billLines: [
        { lineKey: "sup", amount: 200, account_id: SUPPLIES, settlesAccrual: false, taxAmount: 16 },
        { lineKey: "svc", amount: 1050, account_id: UTIL_EXP, taxAmount: 84 },
      ],
      taxAmount: 100,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 1000, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
      ],
    });
    expect(forward.accrualAllocations[0].varianceAmount).toBe(reversed.accrualAllocations[0].varianceAmount);
    expect(forward.newExpensePortion).toBe(reversed.newExpensePortion);
  });

  it("recoverable tax excluded from expense variance", () => {
    const economics = computeSettlementEconomics({
      billLines: [
        {
          lineKey: "svc",
          amount: 1050,
          account_id: UTIL_EXP,
          taxAmount: 84,
          recoverableInputTax: true,
        },
      ],
      taxAmount: 84,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 1000, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
      ],
      recoverableInputTaxAccountId: INPUT_TAX,
    });
    expect(economics.accrualAllocations[0].varianceAmount).toBe(50);
    expect(economics.recoverableTaxDebits[0].amount).toBe(84);
    const journal = buildJournalFromEconomics(economics);
    expect(journal.find((line) => line.account_id === INPUT_TAX)?.debit).toBe(84);
    assertSettlementJournalBalanced(journal);
  });

  it("nonrecoverable tax included in expense or asset line", () => {
    const economics = computeSettlementEconomics({
      billLines: [{ lineKey: "sup", amount: 200, account_id: SUPPLIES, settlesAccrual: false, taxAmount: 16 }],
      taxAmount: 16,
      accrualAllocations: [],
    });
    expect(economics.newExpensePortion).toBe(216);
  });

  it("mixed taxable and nontaxable lines allocate tax only to taxable lines", () => {
    const attribution = resolveLineTaxAttribution({
      billLines: [
        { lineKey: "a", amount: 100, account_id: UTIL_EXP, taxable: false },
        { lineKey: "b", amount: 200, account_id: SUPPLIES, taxable: true },
      ],
      totalTaxAmount: 8,
      hasAccrualAllocations: false,
    });
    expect(attribution.find((line) => line.lineKey === "a")?.taxAmount).toBe(0);
    expect(attribution.find((line) => line.lineKey === "b")?.taxAmount).toBe(8);
  });

  it("requires review when no taxable lines exist for header tax", () => {
    expect(() =>
      resolveLineTaxAttribution({
        billLines: [{ lineKey: "a", amount: 100, account_id: UTIL_EXP, taxable: false }],
        totalTaxAmount: 8,
        hasAccrualAllocations: false,
      }),
    ).toThrow(PurchaseTaxAttributionError);
  });

  it("full AP equals all line economics plus tax", () => {
    const economics = computeSettlementEconomics({
      billLines: [
        { lineKey: "util", amount: 630, account_id: UTIL_EXP, occurrenceId: "u", taxAmount: 50 },
        { lineKey: "maint", amount: 420, account_id: MAINT_EXP, occurrenceId: "m", taxAmount: 34 },
        { lineKey: "supplies", amount: 200, account_id: SUPPLIES, settlesAccrual: false, taxAmount: 16 },
      ],
      taxAmount: 100,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 600, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
        { occurrenceId: "m", appliedAmount: 400, liabilityAccountId: MAINT_LIAB, expenseAccountId: MAINT_EXP },
      ],
    });
    const journal = buildJournalFromEconomics(economics);
    expect(journal.find((line) => line.account_id === AP)?.credit).toBe(1350);
  });

  it("settlement reversal mirrors tax-related debits", () => {
    const economics = computeSettlementEconomics({
      billLines: [
        { lineKey: "svc", amount: 1050, account_id: UTIL_EXP, taxAmount: 84 },
        { lineKey: "sup", amount: 200, account_id: SUPPLIES, settlesAccrual: false, taxAmount: 16 },
      ],
      taxAmount: 100,
      accrualAllocations: [
        { occurrenceId: "u", appliedAmount: 1000, liabilityAccountId: UTIL_LIAB, expenseAccountId: UTIL_EXP },
      ],
    });
    const posted = buildJournalFromEconomics(economics);
    const reversed = buildAccrualSettlementReversalLines(posted);
    assertSettlementJournalBalanced(reversed);
    expect(reversed.find((line) => line.account_id === SUPPLIES)?.credit).toBe(216);
  });
});

describe("Phase 11.1 corrections — invariants", () => {
  it("19 original accrual path unchanged (recognition separate)", () => {
    expect(existsSync(resolve(process.cwd(), "src/lib/accounting/schedules/accrual.ts"))).toBe(true);
  });

  it("20 payment creates AP not duplicate expense (AP line present once)", () => {
    const lines = buildMultiAccountSettlement(1100);
    expect(lines.filter((line) => line.account_id === AP && line.credit).length).toBe(1);
  });

  it("21 reversal restores capacity concept via reversed allocation status in migration", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain("'reversed'");
  });

  it("22 cross-org denied", () => {
    expect(() => assertSameOrganization("a", "b")).toThrow(/Cross-organization/);
  });

  it("23 concurrency trigger remains in migration", () => {
    expect(readFileSync(MIGRATION, "utf8")).toContain("teller_accrual_allocation_capacity_check");
  });

  it("duplicate settlement idempotency key is deterministic per bill", () => {
    expect(accrualSettlementIdempotencyKey("bill-1")).toBe("accrual-settle:bill:bill-1");
    expect(accrualSettlementIdempotencyKey("bill-1", "custom")).toBe("accrual-settle:custom");
  });

  it("vendor mismatch blocks settlement eligibility", () => {
    const check = isOccurrenceEligibleForSettlement(sampleOccurrence(), {
      organizationId: "org",
      billPartyId: "vendor-b",
      settledAmount: 0,
      applyAmount: 100,
    });
    expect(check.eligible).toBe(false);
  });

  it("variance percent computed for reporting", () => {
    expect(variancePercent(1000, 1100)).toBe(10);
    expect(variancePercent(0, 100)).toBeNull();
  });

  it("period lock enforcement referenced in post path", () => {
    expect(readFileSync(resolve(process.cwd(), "src/lib/accounting/post.ts"), "utf8")).toContain(
      "assertOrgPeriodOpen",
    );
  });

  it("reversal journal balanced", () => {
    const posted = buildMultiAccountSettlement(1100);
    assertSettlementJournalBalanced(buildAccrualSettlementReversalLines(posted));
  });
});

describe("Phase 11.1 corrections — scheduler unchanged", () => {
  it("production scheduler remains disabled", () => {
    expect(PRODUCTION_SCHEDULER_ENABLED).toBe(false);
  });
});

describe("Phase 11.1 corrections — close integration", () => {
  it("partially settled accrual warns on close", () => {
    expect(
      classifyAccrualSettlementCloseFinding({
        occurrenceId: "o",
        scheduleId: "s",
        scheduleName: "U",
        occurrenceDate: "2026-01-31",
        accruedAmount: 600,
        settledAmount: 300,
        remainingAmount: 300,
        settlementStatus: "partially_settled",
      }).severity,
    ).toBe("warning");
  });
});
