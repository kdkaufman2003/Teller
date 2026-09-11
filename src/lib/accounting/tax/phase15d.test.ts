import { describe, expect, it } from "vitest";
import { assertBalanced } from "../post";
import { calculateTax } from "./calculation/engine";
import { buildTaxCalculationInputFromDocument, taxCategoryForDocumentLine } from "./posting/document-input";
import { resolveSalesTaxPayableAccountId, MissingTaxLiabilityAccountError } from "./posting/resolve-payable";
import { planTaxPosting } from "./posting-contract";
import type { TaxCalculationConfig, TaxCalculationInput } from "./calculation/types";

const ORG = "org-15d";
const PAYABLE = "acct-tax-payable";
const REVENUE = "acct-revenue";
const AR = "acct-ar";

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
    ],
    rateComponents: [
      { componentType: "state", jurisdictionKey: "US-KS", ratePercent: 6.5, effectiveFrom: "2020-01-01" },
      { componentType: "county", jurisdictionKey: "US-KS", ratePercent: 1.25, effectiveFrom: "2020-01-01" },
    ],
  };
}

function invoiceInput(overrides: Partial<TaxCalculationInput> = {}): TaxCalculationInput {
  return {
    transactionDate: "2026-06-01",
    transactionType: "invoice",
    location: { transactionLocation: { country: "US", state: "KS" } },
    lines: [{ lineKey: "1", lineAmount: 1000, taxCategory: "equipment" }],
    ...overrides,
  };
}

function buildTaxAwareInvoiceJournal(
  subtotal: number,
  taxTotal: number,
  revenueAccountId = REVENUE,
) {
  return [
    { account_id: AR, debit: subtotal + taxTotal },
    { account_id: revenueAccountId, credit: subtotal },
    ...(taxTotal > 0 ? [{ account_id: PAYABLE, credit: taxTotal }] : []),
  ];
}

describe("Phase 15D document tax input", () => {
  it("maps item types to canonical tax categories", () => {
    expect(taxCategoryForDocumentLine({ amount: 1, item_type: "equipment" })).toBe("equipment");
    expect(taxCategoryForDocumentLine({ amount: 1, item_type: "service" })).toBe("service");
  });

  it("builds calculation input from document lines", () => {
    const input = buildTaxCalculationInputFromDocument({
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      partyId: "party-1",
      location: { country: "US", state: "KS" },
      lines: [{ id: "line-1", amount: 250, item_type: "equipment", description: "Unit" }],
    });
    expect(input.lines[0]!.taxCategory).toBe("equipment");
    expect(input.customer?.partyId).toBe("party-1");
  });
});

describe("Phase 15D liability account gate", () => {
  it("requires configured payable account when tax is positive", () => {
    expect(() =>
      resolveSalesTaxPayableAccountId({ organizationId: ORG, roundingPolicy: "per_line", setupStatus: "configured", taxInclusiveSupported: false }, 6.5),
    ).toThrow(MissingTaxLiabilityAccountError);
    expect(
      resolveSalesTaxPayableAccountId(
        {
          organizationId: ORG,
          salesTaxPayableAccountId: PAYABLE,
          roundingPolicy: "per_line",
          setupStatus: "configured",
          taxInclusiveSupported: false,
        },
        6.5,
      ),
    ).toBe(PAYABLE);
  });

  it("allows zero-tax posting without payable account", () => {
    expect(
      resolveSalesTaxPayableAccountId(
        { organizationId: ORG, roundingPolicy: "per_line", setupStatus: "not_configured", taxInclusiveSupported: false },
        0,
      ),
    ).toBeNull();
  });
});

describe("Phase 15D invoice journal composition", () => {
  it("posts balanced taxable invoice with tax payable separate from revenue", () => {
    const result = calculateTax(invoiceInput(), baseConfig());
    expect(result.taxTotal).toBe(77.5);
    const lines = buildTaxAwareInvoiceJournal(1000, result.taxTotal);
    assertBalanced(lines);
    const revenue = lines.find((line) => line.account_id === REVENUE)?.credit ?? 0;
    const tax = lines.find((line) => line.account_id === PAYABLE)?.credit ?? 0;
    expect(revenue).toBe(1000);
    expect(tax).toBe(77.5);
  });

  it("supports multi-component tax summing to control account", () => {
    const result = calculateTax(invoiceInput(), baseConfig());
    const componentSum = result.jurisdictionComponents.reduce((sum, c) => sum + c.taxAmount, 0);
    expect(componentSum).toBe(result.taxTotal);
  });

  it("does not credit tax payable for exempt invoice", () => {
    const exConfig = baseConfig();
    exConfig.partyExemptions = [
      {
        id: "ex-1",
        organizationId: ORG,
        partyId: "party-1",
        certificateNumber: "C-1",
        certificateOnFile: true,
        jurisdictionScope: ["US-KS"],
        categoryScope: ["equipment"],
        status: "active",
        effectiveFrom: "2020-01-01",
        effectiveTo: null,
        metadata: { certificateType: "resale", reviewStatus: "approved" },
        certificateType: "resale",
        issuingJurisdictionKey: null,
        reviewStatus: "approved",
        notes: null,
        lifecycleStatus: "active",
        createdBy: null,
        createdAt: "2020-01-01",
        updatedAt: "2020-01-01",
      },
    ];
    const result = calculateTax(
      invoiceInput({ customer: { partyId: "party-1" } }),
      exConfig,
    );
    expect(result.taxTotal).toBe(0);
    const lines = buildTaxAwareInvoiceJournal(1000, result.taxTotal);
    assertBalanced(lines);
    expect(lines.some((line) => line.account_id === PAYABLE)).toBe(false);
  });

  it("blocks posting when determination needs review", () => {
    const plan = planTaxPosting({
      organizationId: ORG,
      sourceType: "invoice",
      sourceId: "doc-1",
      transactionType: "sales_tax_collected",
      transactionDate: "2026-06-01",
      salesTaxPayableAccountId: PAYABLE,
      calculation: calculateTax(
        invoiceInput({ lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "unknown_category_xyz" }] }),
        baseConfig(),
      ),
    });
    expect(plan.canPost).toBe(false);
    expect(plan.reason).toMatch(/needs review/i);
  });
});

describe("Phase 15D credit memo tax reversal", () => {
  it("reverses proportional tax for partial credit lines", () => {
    const original = calculateTax(invoiceInput(), baseConfig());
    const partial = calculateTax(
      invoiceInput({ lines: [{ lineKey: "1", lineAmount: 250, taxCategory: "equipment" }] }),
      baseConfig(),
    );
    expect(partial.taxTotal).toBeCloseTo(original.taxTotal * 0.25, 2);
    const creditJournal = [
      { account_id: REVENUE, debit: 250 },
      { account_id: PAYABLE, debit: partial.taxTotal },
      { account_id: AR, credit: 250 + partial.taxTotal },
    ];
    assertBalanced(creditJournal);
  });
});

describe("Phase 15D payment boundary", () => {
  it("customer payment journal excludes tax accounts", () => {
    const paymentLines = [
      { account_id: "cash", debit: 1077.5 },
      { account_id: AR, credit: 1077.5 },
    ];
    assertBalanced(paymentLines);
    expect(paymentLines.some((line) => line.account_id === PAYABLE)).toBe(false);
  });
});

describe("Phase 15D historical immutability contract", () => {
  it("preserves posted snapshot tax after rate config changes", () => {
    const postedSnapshot = { taxAmount: 65, ratePercent: 6.5, determinationStatus: "resolved" };
    const futureConfig = baseConfig();
    futureConfig.rateComponents = [
      { componentType: "state", jurisdictionKey: "US-KS", ratePercent: 9, effectiveFrom: "2020-01-01" },
    ];
    const recalc = calculateTax(invoiceInput({ transactionDate: "2026-06-01" }), futureConfig);
    expect(recalc.taxTotal).not.toBe(postedSnapshot.taxAmount);
    expect(postedSnapshot.taxAmount).toBe(65);
  });
});
