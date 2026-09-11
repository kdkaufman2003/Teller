import { describe, expect, it } from "vitest";
import { calculateTax, reconcileDocumentTotals, TAX_ENGINE_VERSION } from "./calculation/engine";
import { buildLineDeterminationSnapshot } from "./calculation/snapshot";
import { TaxReviewReason } from "./calculation/reason-codes";
import { toCents } from "./calculation/money";
import type { TaxCalculationConfig, TaxCalculationInput } from "./calculation/types";

const ORG = "org-phase15b-test";

function baseConfig(overrides: Partial<TaxCalculationConfig> = {}): TaxCalculationConfig {
  return {
    organizationId: ORG,
    roundingPolicy: "per_line",
    taxabilityRules: [
      {
        id: "rule-equipment",
        organizationId: ORG,
        jurisdictionKey: "US-KS",
        taxCategoryKey: "equipment",
        treatment: "taxable",
        priority: 100,
        effectiveFrom: "2020-01-01",
        sourceKind: "organization_override",
      },
      {
        id: "rule-labor",
        organizationId: ORG,
        jurisdictionKey: "US-KS",
        taxCategoryKey: "labor",
        treatment: "non_taxable",
        priority: 100,
        effectiveFrom: "2020-01-01",
        sourceKind: "organization_override",
      },
      {
        id: "rule-exempt-cat",
        organizationId: ORG,
        jurisdictionKey: "US-KS",
        taxCategoryKey: "exempt_goods",
        treatment: "exempt",
        priority: 100,
        effectiveFrom: "2020-01-01",
        sourceKind: "organization_override",
      },
    ],
    rateComponents: [
      {
        componentType: "state",
        jurisdictionKey: "US-KS",
        ratePercent: 6.5,
        effectiveFrom: "2020-01-01",
      },
    ],
    ...overrides,
  };
}

function baseInput(overrides: Partial<TaxCalculationInput> = {}): TaxCalculationInput {
  return {
    transactionDate: "2026-06-01",
    transactionType: "invoice",
    mode: "exclusive",
    location: { transactionLocation: { country: "US", state: "KS" } },
    lines: [],
    ...overrides,
  };
}

describe("Phase 15B basic calculation", () => {
  it("calculates single taxable line", () => {
    const result = calculateTax(
      baseInput({
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
      }),
      baseConfig(),
    );
    expect(result.status).toBe("resolved");
    expect(result.taxTotal).toBe(6.5);
    expect(result.lineResults[0]!.taxAmount).toBe(6.5);
    expect(result.lineResults[0]!.treatment).toBe("taxable");
  });

  it("calculates single non-taxable line", () => {
    const result = calculateTax(
      baseInput({
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "labor" }],
      }),
      baseConfig(),
    );
    expect(result.lineResults[0]!.nonTaxableBasis).toBe(100);
    expect(result.lineResults[0]!.taxAmount).toBe(0);
    expect(result.lineResults[0]!.determinationStatus).toBe("non_taxable");
  });

  it("calculates single exempt line", () => {
    const result = calculateTax(
      baseInput({
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "exempt_goods" }],
      }),
      baseConfig(),
    );
    expect(result.lineResults[0]!.exemptBasis).toBe(100);
    expect(result.lineResults[0]!.taxAmount).toBe(0);
    expect(result.lineResults[0]!.determinationStatus).toBe("exempt");
  });

  it("flags needs-review line when category missing", () => {
    const result = calculateTax(
      baseInput({ lines: [{ lineKey: "1", lineAmount: 50 }] }),
      baseConfig(),
    );
    expect(result.status).toBe("needs_review");
    expect(result.lineResults[0]!.reasonCodes).toContain(TaxReviewReason.MISSING_TAX_CATEGORY);
  });

  it("handles mixed document with partial resolution", () => {
    const result = calculateTax(
      baseInput({
        lines: [
          { lineKey: "1", lineAmount: 100, taxCategory: "equipment" },
          { lineKey: "2", lineAmount: 50, taxCategory: "labor" },
          { lineKey: "3", lineAmount: 25 },
        ],
      }),
      baseConfig(),
    );
    expect(result.status).toBe("needs_review");
    expect(result.lineResults[0]!.taxAmount).toBe(6.5);
    expect(result.lineResults[1]!.taxAmount).toBe(0);
    expect(result.lineResults[2]!.determinationStatus).toBe("needs_review");
  });

  it("distinguishes zero-rate taxable from non-taxable", () => {
    const result = calculateTax(
      baseInput({
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
      }),
      baseConfig({
        rateComponents: [
          { componentType: "state", jurisdictionKey: "US-KS", ratePercent: 0, effectiveFrom: "2020-01-01" },
        ],
      }),
    );
    expect(result.lineResults[0]!.treatment).toBe("taxable");
    expect(result.lineResults[0]!.zeroRateTaxable).toBe(true);
    expect(result.lineResults[0]!.taxAmount).toBe(0);
    expect(result.lineResults[0]!.determinationStatus).toBe("resolved");
  });
});

describe("Phase 15B multi-component and modes", () => {
  it("composes multiple jurisdiction components", () => {
    const result = calculateTax(
      baseInput({
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
      }),
      baseConfig({
        rateComponents: [
          { componentType: "state", jurisdictionKey: "US-KS", ratePercent: 6.5, effectiveFrom: "2020-01-01" },
          { componentType: "county", jurisdictionKey: "US-KS", ratePercent: 1.25, effectiveFrom: "2020-01-01" },
        ],
      }),
    );
    expect(result.taxTotal).toBe(7.75);
    expect(result.jurisdictionComponents.length).toBe(2);
  });

  it("calculates tax-exclusive totals", () => {
    const result = calculateTax(
      baseInput({
        mode: "exclusive",
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
      }),
      baseConfig(),
    );
    expect(result.taxTotal).toBe(6.5);
    const recon = reconcileDocumentTotals(100, result);
    expect(recon.ok).toBe(true);
    expect(recon.taxDifferenceCents).toBe(0);
  });

  it("calculates tax-inclusive totals without inflating document total", () => {
    const result = calculateTax(
      baseInput({
        mode: "inclusive",
        lines: [{ lineKey: "1", lineAmount: 108, taxCategory: "equipment", taxInclusive: true }],
      }),
      baseConfig({
        rateComponents: [
          { componentType: "state", jurisdictionKey: "US-KS", ratePercent: 8, effectiveFrom: "2020-01-01" },
        ],
      }),
    );
    expect(result.lineResults[0]!.taxableBasis).toBe(100);
    expect(result.lineResults[0]!.taxAmount).toBe(8);
    expect(result.taxTotal).toBe(8);
  });
});

describe("Phase 15B effective dating", () => {
  it("uses rate active on transaction date", () => {
    const config = baseConfig({
      rateComponents: [
        { componentType: "state", jurisdictionKey: "US-KS", ratePercent: 5, effectiveFrom: "2026-01-01", effectiveTo: "2026-05-31" },
        { componentType: "state", jurisdictionKey: "US-KS", ratePercent: 7, effectiveFrom: "2026-06-01" },
      ],
    });
    const past = calculateTax(
      baseInput({ transactionDate: "2026-05-15", lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }] }),
      config,
    );
    const present = calculateTax(
      baseInput({ transactionDate: "2026-06-01", lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }] }),
      config,
    );
    expect(past.taxTotal).toBe(5);
    expect(present.taxTotal).toBe(7);
  });

  it("rejects future rate for past transaction", () => {
    const result = calculateTax(
      baseInput({
        transactionDate: "2026-01-01",
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
      }),
      baseConfig({
        rateComponents: [
          { componentType: "state", jurisdictionKey: "US-KS", ratePercent: 6.5, effectiveFrom: "2026-06-01" },
        ],
      }),
    );
    expect(result.status).toBe("needs_review");
    expect(result.reasonCodes).toContain(TaxReviewReason.NO_ACTIVE_TAX_RATE);
  });

  it("respects rule effective boundaries", () => {
    const result = calculateTax(
      baseInput({
        transactionDate: "2025-12-31",
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
      }),
      baseConfig({
        taxabilityRules: [
          {
            id: "future-rule",
            organizationId: ORG,
            jurisdictionKey: "US-KS",
            taxCategoryKey: "equipment",
            treatment: "taxable",
            priority: 100,
            effectiveFrom: "2026-01-01",
            sourceKind: "organization_override",
          },
        ],
      }),
    );
    expect(result.lineResults[0]!.reasonCodes).toContain(TaxReviewReason.NO_TAXABILITY_RULE);
  });
});

describe("Phase 15B rule precedence", () => {
  it("prefers explicit line override over exemption", () => {
    const result = calculateTax(
      baseInput({
        customer: {
          exemption: {
            status: "active",
            effectiveFrom: "2020-01-01",
            jurisdictionScope: ["*"],
            categoryScope: ["*"],
          },
        },
        lines: [
          {
            lineKey: "1",
            lineAmount: 100,
            taxCategory: "equipment",
            explicitTaxabilityOverride: "non_taxable",
          },
        ],
      }),
      baseConfig(),
    );
    expect(result.lineResults[0]!.treatment).toBe("non_taxable");
    expect(result.lineResults[0]!.precedenceSource).toBe("line_override");
  });

  it("applies valid customer exemption", () => {
    const result = calculateTax(
      baseInput({
        customer: {
          exemption: {
            status: "active",
            effectiveFrom: "2020-01-01",
            jurisdictionScope: ["US-KS"],
            categoryScope: ["equipment"],
          },
        },
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
      }),
      baseConfig(),
    );
    expect(result.lineResults[0]!.treatment).toBe("exempt");
    expect(result.lineResults[0]!.precedenceSource).toBe("customer_exemption");
  });

  it("rejects expired exemption", () => {
    const result = calculateTax(
      baseInput({
        customer: {
          exemption: {
            status: "active",
            effectiveFrom: "2020-01-01",
            effectiveTo: "2025-12-31",
            jurisdictionScope: ["*"],
            categoryScope: ["*"],
          },
        },
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
      }),
      baseConfig(),
    );
    expect(result.lineResults[0]!.treatment).toBe("taxable");
    expect(result.lineResults[0]!.taxAmount).toBe(6.5);
  });
});

describe("Phase 15B rounding and reconciliation", () => {
  it("rounds deterministically to cents without floating drift", () => {
    const result = calculateTax(
      baseInput({
        lines: [
          { lineKey: "1", lineAmount: 10.005, taxCategory: "equipment" },
          { lineKey: "2", lineAmount: 10.005, taxCategory: "equipment" },
        ],
      }),
      baseConfig({
        rateComponents: [
          { componentType: "state", jurisdictionKey: "US-KS", ratePercent: 8.875, effectiveFrom: "2020-01-01" },
        ],
      }),
    );
    const summedCents = result.lineResults.reduce((sum, line) => sum + toCents(line.taxAmount), 0);
    expect(toCents(result.taxTotal)).toBe(summedCents);
    expect(Number.isInteger(toCents(result.taxTotal))).toBe(true);
  });

  it("reconciles line tax to document tax total", () => {
    const result = calculateTax(
      baseInput({
        lines: [
          { lineKey: "1", lineAmount: 33.33, taxCategory: "equipment" },
          { lineKey: "2", lineAmount: 66.67, taxCategory: "equipment" },
        ],
      }),
      baseConfig(),
    );
    const recon = reconcileDocumentTotals(100, result);
    expect(recon.taxDifferenceCents).toBe(0);
    expect(recon.lineDifferenceCents).toBe(0);
  });

  it("handles negative line amounts deterministically", () => {
    const result = calculateTax(
      baseInput({
        lines: [{ lineKey: "1", lineAmount: -100, taxCategory: "equipment" }],
      }),
      baseConfig(),
    );
    expect(result.lineResults[0]!.taxAmount).toBe(-6.5);
    expect(result.lineResults[0]!.treatment).toBe("taxable");
  });
});

describe("Phase 15B ambiguity handling", () => {
  it("returns needs_review for ambiguous tax rules", () => {
    const result = calculateTax(
      baseInput({ lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }] }),
      baseConfig({
        taxabilityRules: [
          {
            id: "a",
            organizationId: ORG,
            jurisdictionKey: "US-KS",
            taxCategoryKey: "equipment",
            treatment: "taxable",
            priority: 100,
            effectiveFrom: "2020-01-01",
            sourceKind: "organization_override",
          },
          {
            id: "b",
            organizationId: ORG,
            jurisdictionKey: "US-KS",
            taxCategoryKey: "equipment",
            treatment: "non_taxable",
            priority: 100,
            effectiveFrom: "2020-01-01",
            sourceKind: "organization_override",
          },
        ],
      }),
    );
    expect(result.lineResults[0]!.reasonCodes).toContain(TaxReviewReason.AMBIGUOUS_TAX_RULE);
  });

  it("returns needs_review for ambiguous overlapping rates", () => {
    const result = calculateTax(
      baseInput({ lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }] }),
      baseConfig({
        rateComponents: [
          { componentType: "state", jurisdictionKey: "US-KS", ratePercent: 6.5, effectiveFrom: "2020-01-01" },
          { componentType: "state", jurisdictionKey: "US-KS", ratePercent: 7, effectiveFrom: "2020-01-01" },
        ],
      }),
    );
    expect(result.lineResults[0]!.reasonCodes).toContain(TaxReviewReason.AMBIGUOUS_TAX_RATE);
  });

  it("returns needs_review when location missing", () => {
    const result = calculateTax(
      baseInput({
        location: {},
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
      }),
      baseConfig(),
    );
    expect(result.reasonCodes).toContain(TaxReviewReason.MISSING_TAX_LOCATION);
  });

  it("prefers exact jurisdiction rate over broader state reference rate", () => {
    const result = calculateTax(
      baseInput({
        location: { transactionLocation: { country: "US", state: "KS", county: "P15BEFF" } },
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
      }),
      baseConfig({
        rateComponents: [
          { componentType: "state", jurisdictionKey: "US-KS", ratePercent: 6.5, effectiveFrom: "2020-01-01" },
          {
            componentType: "state",
            jurisdictionKey: "US-KS-P15BEFF",
            ratePercent: 5,
            effectiveFrom: "2020-01-01",
          },
        ],
      }),
    );
    expect(result.taxTotal).toBe(5);
  });
});

describe("Phase 15B snapshot and engine version", () => {
  it("serializes determination snapshot with engine version", () => {
    const input = baseInput({ lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }] });
    const result = calculateTax(input, baseConfig());
    const snapshot = buildLineDeterminationSnapshot(ORG, input.transactionDate, result.lineResults[0]!, result);
    expect(snapshot.metadata.engineVersion).toBe(TAX_ENGINE_VERSION);
    expect(snapshot.taxAmount).toBe(6.5);
    expect(snapshot.components.length).toBeGreaterThan(0);
  });

  it("uses stable engine version identifier", () => {
    expect(TAX_ENGINE_VERSION).toBe("teller_tax_engine_v1");
  });
});

describe("Phase 15B tenant isolation (in-memory)", () => {
  it("uses only org-scoped rules passed in config", () => {
    const orgA = baseConfig({
      organizationId: "org-a",
      taxabilityRules: [
        {
          id: "a",
          organizationId: "org-a",
          jurisdictionKey: "US-KS",
          taxCategoryKey: "equipment",
          treatment: "taxable",
          priority: 100,
          effectiveFrom: "2020-01-01",
          sourceKind: "organization_override",
        },
      ],
    });
    const orgB = baseConfig({
      organizationId: "org-b",
      taxabilityRules: [
        {
          id: "b",
          organizationId: "org-b",
          jurisdictionKey: "US-KS",
          taxCategoryKey: "equipment",
          treatment: "non_taxable",
          priority: 100,
          effectiveFrom: "2020-01-01",
          sourceKind: "organization_override",
        },
      ],
    });
    const input = baseInput({ lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }] });
    const resultA = calculateTax(input, orgA);
    const resultB = calculateTax(input, orgB);
    expect(resultA.lineResults[0]!.taxAmount).toBe(6.5);
    expect(resultB.lineResults[0]!.taxAmount).toBe(0);
  });
});
