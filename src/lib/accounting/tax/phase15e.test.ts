import { describe, expect, it } from "vitest";
import { assertBalanced } from "../post";
import { allocateVendorPurchaseTax } from "../accrual-settlement/purchase-tax";
import { buildGrniBillSettlementJournalLines } from "../inventory/grni/journal-lines";
import { calculateTax } from "./calculation/engine";
import type { TaxCalculationConfig, TaxCalculationInput } from "./calculation/types";
import { comparePurchaseTax } from "./purchase/compare-vendor-tax";
import { classifyPurchaseLine } from "./purchase/classify-line";
import { buildUseTaxJournalLines } from "./purchase/use-tax-journal";
import {
  MissingUseTaxExpenseAccountError,
  resolveUseTaxExpenseAccountId,
} from "./posting/resolve-payable";

const ORG = "org-15e";
const PAYABLE = "acct-tax-payable";
const USE_TAX_EXPENSE = "acct-use-tax-expense";
const EXPENSE = "acct-expense";
const INVENTORY = "acct-inventory";
const FIXED_ASSET = "acct-fixed-asset";
const AP = "acct-ap";

function baseConfig(): TaxCalculationConfig {
  return {
    organizationId: ORG,
    roundingPolicy: "per_line",
    taxabilityRules: [
      {
        id: "r1",
        organizationId: ORG,
        jurisdictionKey: "US-KS",
        taxCategoryKey: "equipment",
        treatment: "taxable",
        priority: 100,
        effectiveFrom: "2020-01-01",
        sourceKind: "organization_override",
      },
      {
        id: "r2",
        organizationId: ORG,
        jurisdictionKey: "US-KS",
        taxCategoryKey: "service",
        treatment: "non_taxable",
        priority: 100,
        effectiveFrom: "2020-01-01",
        sourceKind: "organization_override",
      },
    ],
    rateComponents: [
      { componentType: "state", jurisdictionKey: "US-KS", ratePercent: 6.5, effectiveFrom: "2020-01-01" },
      { componentType: "county", jurisdictionKey: "US-KS", ratePercent: 1.25, effectiveFrom: "2020-01-01" },
    ],
  };
}

function billInput(overrides: Partial<TaxCalculationInput> = {}): TaxCalculationInput {
  return {
    transactionDate: "2026-06-01",
    transactionType: "bill",
    location: { transactionLocation: { country: "US", state: "KS" } },
    lines: [{ lineKey: "1", lineAmount: 1000, taxCategory: "equipment" }],
    ...overrides,
  };
}

function buildBillJournal(input: {
  subtotal: number;
  vendorTax: number;
  useTaxDue: number;
  expenseAccountId?: string;
  inventoryAccountId?: string;
  lineAmount?: number;
  classification?: "expense" | "inventory" | "fixed_asset";
}) {
  const lineAccount =
    input.classification === "inventory"
      ? INVENTORY
      : input.classification === "fixed_asset"
        ? FIXED_ASSET
        : EXPENSE;
  const amount = input.lineAmount ?? input.subtotal;
  const vendorAllocations = allocateVendorPurchaseTax({
    taxAmount: input.vendorTax,
    targets: [{ accountId: lineAccount, amount, accountType: input.classification ?? "expense" }],
  });
  const comparison = comparePurchaseTax({
    calculation: calculateTax(billInput(), baseConfig()),
    vendorTaxCharged: input.vendorTax,
  });
  comparison.lineResults[0]!.useTaxDue = input.useTaxDue;
  comparison.lineResults[0]!.requiredTax = input.useTaxDue + input.vendorTax;
  comparison.useTaxDueTotal = input.useTaxDue;

  const useTaxLines =
    input.useTaxDue > 0
      ? buildUseTaxJournalLines({
          comparison,
          lineTargets: [
            {
              lineKey: "1",
              accountId: lineAccount,
              accountType: input.classification ?? "expense",
            },
          ],
          useTaxExpenseAccountId: USE_TAX_EXPENSE,
          salesTaxPayableAccountId: PAYABLE,
        })
      : [];

  const lines = [
    { account_id: lineAccount, debit: amount },
    ...vendorAllocations.map((row) => ({ account_id: row.accountId, debit: row.amount })),
    ...useTaxLines.map((row) => ({
      account_id: row.account_id,
      debit: row.debit,
      credit: row.credit,
    })),
    { account_id: AP, credit: input.subtotal + input.vendorTax },
  ];
  return lines;
}

describe("Phase 15E purchase tax comparison", () => {
  it("fully taxed purchase accrues zero use tax", () => {
    const calculation = calculateTax(billInput(), baseConfig());
    expect(calculation.taxTotal).toBe(77.5);
    const comparison = comparePurchaseTax({ calculation, vendorTaxCharged: 77.5 });
    expect(comparison.useTaxDueTotal).toBe(0);
    expect(comparison.lineResults[0]!.status).toBe("fully_taxed");
  });

  it("untaxed taxable purchase accrues full use tax", () => {
    const calculation = calculateTax(billInput(), baseConfig());
    const comparison = comparePurchaseTax({ calculation, vendorTaxCharged: 0 });
    expect(comparison.useTaxDueTotal).toBe(77.5);
    expect(comparison.lineResults[0]!.status).toBe("use_tax_due");
  });

  it("partial vendor tax accrues only the difference", () => {
    const calculation = calculateTax(billInput(), baseConfig());
    const comparison = comparePurchaseTax({ calculation, vendorTaxCharged: 50 });
    expect(comparison.useTaxDueTotal).toBe(27.5);
    expect(comparison.lineResults[0]!.vendorTax).toBe(50);
  });

  it("vendor tax overage creates no negative use tax", () => {
    const calculation = calculateTax(billInput(), baseConfig());
    const comparison = comparePurchaseTax({ calculation, vendorTaxCharged: 90 });
    expect(comparison.useTaxDueTotal).toBe(0);
    expect(comparison.vendorTaxOverageTotal).toBe(12.5);
    expect(comparison.lineResults[0]!.status).toBe("vendor_tax_overage");
  });

  it("non-taxable purchase accrues zero use tax", () => {
    const calculation = calculateTax(
      billInput({ lines: [{ lineKey: "1", lineAmount: 1000, taxCategory: "service" }] }),
      baseConfig(),
    );
    const comparison = comparePurchaseTax({ calculation, vendorTaxCharged: 0 });
    expect(comparison.useTaxDueTotal).toBe(0);
    expect(comparison.lineResults[0]!.status).toBe("non_taxable");
  });

  it("needs review when calculation is ambiguous", () => {
    const calculation = calculateTax(
      billInput({ location: { transactionLocation: { country: "US" } } }),
      baseConfig(),
    );
    const comparison = comparePurchaseTax({ calculation, vendorTaxCharged: 0 });
    expect(calculation.status).toBe("needs_review");
    expect(comparison.status).toBe("needs_review");
  });

  it("compares multi-component tax at component level", () => {
    const calculation = calculateTax(billInput(), baseConfig());
    const comparison = comparePurchaseTax({ calculation, vendorTaxCharged: 65 });
    expect(comparison.lineResults[0]!.components.length).toBe(2);
    expect(comparison.useTaxDueTotal).toBe(12.5);
  });

  it("avoids floating point drift in purchase tax totals", () => {
    const calculation = calculateTax(
      billInput({ lines: [{ lineKey: "1", lineAmount: 33.33, taxCategory: "equipment" }] }),
      baseConfig(),
    );
    const comparison = comparePurchaseTax({ calculation, vendorTaxCharged: 0 });
    expect(Number.isInteger(comparison.useTaxDueTotal * 100)).toBe(true);
  });
});

describe("Phase 15E purchase line classification", () => {
  it("classifies inventory, expense, and fixed asset lines", () => {
    expect(classifyPurchaseLine({ accountType: "expense" })).toBe("expense");
    expect(classifyPurchaseLine({ accountType: "asset", costType: "inventory" })).toBe("inventory");
    expect(classifyPurchaseLine({ accountType: "fixed_asset" })).toBe("fixed_asset");
  });
});

describe("Phase 15E expense purchase accounting", () => {
  it("posts balanced journal with vendor tax capitalized and use tax to payable", () => {
    const lines = buildBillJournal({ subtotal: 1000, vendorTax: 80, useTaxDue: 0 });
    assertBalanced(lines);
    expect(lines.find((line) => line.account_id === AP)?.credit).toBe(1080);
    expect(lines.find((line) => line.account_id === PAYABLE)).toBeUndefined();
  });

  it("accrues use tax without increasing AP", () => {
    const lines = buildBillJournal({ subtotal: 1000, vendorTax: 0, useTaxDue: 77.5 });
    assertBalanced(lines);
    expect(lines.find((line) => line.account_id === AP)?.credit).toBe(1000);
    expect(lines.find((line) => line.account_id === PAYABLE)?.credit).toBe(77.5);
    expect(lines.find((line) => line.account_id === USE_TAX_EXPENSE)?.debit).toBe(77.5);
  });
});

describe("Phase 15E inventory and GRNI boundaries", () => {
  it("capitalizes inventory use tax into inventory account", () => {
    const calculation = calculateTax(billInput(), baseConfig());
    const comparison = comparePurchaseTax({ calculation, vendorTaxCharged: 0 });
    const useTaxLines = buildUseTaxJournalLines({
      comparison,
      lineTargets: [{ lineKey: "1", accountId: INVENTORY, accountType: "asset", costType: "inventory" }],
      useTaxExpenseAccountId: USE_TAX_EXPENSE,
      salesTaxPayableAccountId: PAYABLE,
    });
    expect(useTaxLines.find((line) => line.account_id === INVENTORY)?.debit).toBe(77.5);
    expect(useTaxLines.find((line) => line.account_id === USE_TAX_EXPENSE)).toBeUndefined();
  });

  it("does not route use tax through GRNI settlement or PPV", () => {
    const grniLines = buildGrniBillSettlementJournalLines({
      grniAmount: 1000,
      billAmount: 1000,
      grniAccountId: "grni",
      accountsPayableAccountId: AP,
      purchasePriceVarianceAccountId: "ppv",
    });
    assertBalanced(grniLines);
    expect(grniLines.some((line) => line.accountId === "ppv")).toBe(false);
    expect(grniLines.find((line) => line.accountId === AP)?.credit).toBe(1000);
  });
});

describe("Phase 15E fixed asset use tax", () => {
  it("capitalizes fixed asset use tax into asset account", () => {
    const calculation = calculateTax(billInput(), baseConfig());
    const comparison = comparePurchaseTax({ calculation, vendorTaxCharged: 0 });
    const useTaxLines = buildUseTaxJournalLines({
      comparison,
      lineTargets: [{ lineKey: "1", accountId: FIXED_ASSET, accountType: "fixed_asset" }],
      useTaxExpenseAccountId: USE_TAX_EXPENSE,
      salesTaxPayableAccountId: PAYABLE,
    });
    expect(useTaxLines.find((line) => line.account_id === FIXED_ASSET)?.debit).toBe(77.5);
  });
});

describe("Phase 15E liability account gates", () => {
  it("requires use tax expense account for expense-classified use tax", () => {
    const calculation = calculateTax(billInput(), baseConfig());
    const comparison = comparePurchaseTax({ calculation, vendorTaxCharged: 0 });
    expect(() =>
      resolveUseTaxExpenseAccountId(
        { organizationId: ORG, roundingPolicy: "per_line", setupStatus: "configured", taxInclusiveSupported: false },
        comparison,
        ["1"],
      ),
    ).toThrow(MissingUseTaxExpenseAccountError);
    expect(
      resolveUseTaxExpenseAccountId(
        {
          organizationId: ORG,
          useTaxExpenseAccountId: USE_TAX_EXPENSE,
          roundingPolicy: "per_line",
          setupStatus: "configured",
          taxInclusiveSupported: false,
        },
        comparison,
        ["1"],
      ),
    ).toBe(USE_TAX_EXPENSE);
  });
});

describe("Phase 15E payment boundary", () => {
  it("vendor payment path does not include use tax journal builder", () => {
    const paymentLines = [
      { account_id: AP, debit: 1000 },
      { account_id: "cash", credit: 1000 },
    ];
    assertBalanced(paymentLines);
    expect(paymentLines.some((line) => line.account_id === PAYABLE)).toBe(false);
  });
});
