import { describe, expect, it } from "vitest";
import { normalizeTaxCategoryKey, REFERENCE_TAX_CATEGORIES, resolveTaxCategory } from "./categories";
import { calculateTax } from "./calculation-contract";
import { splitTaxExclusive, splitTaxInclusive } from "./inclusive";
import { assertTaxTransactionMutable, POSTED_TAX_HISTORY_IMMUTABLE } from "./immutability";
import { buildJurisdictionPath, validateJurisdictionHierarchy } from "./jurisdiction";
import { taxPostingBlockedByPeriodLock } from "./period-lock";
import { evaluateTaxReadiness, ownerSetupStatusLabel } from "./readiness";
import {
  applyRoundingPolicy,
  combinedRatePercent,
  findOverlappingRateComponents,
  isEffectiveOn,
  taxAmountFromBasis,
  validateEffectiveRange,
  validateRatePercent,
} from "./rates";
import { rejectCrossOrgReference, assertSameOrganization } from "./tenant-isolation";
import { comparePrecedenceSources, resolveTaxRulePrecedence } from "./taxability";
import { planTaxPosting } from "./posting-contract";

describe("Phase 15A jurisdiction model", () => {
  it("validates hierarchy parent types", () => {
    expect(validateJurisdictionHierarchy({ jurisdictionType: "country", parentJurisdictionKey: null }).ok).toBe(true);
    expect(
      validateJurisdictionHierarchy(
        { jurisdictionType: "county", parentJurisdictionKey: "US-KS" },
        { jurisdictionType: "state", jurisdictionKey: "US-KS" },
      ).ok,
    ).toBe(true);
    expect(
      validateJurisdictionHierarchy(
        { jurisdictionType: "state", parentJurisdictionKey: "US-KS-JOCO" },
        { jurisdictionType: "county", jurisdictionKey: "US-KS-JOCO" },
      ).ok,
    ).toBe(false);
  });

  it("builds jurisdiction path from leaf to root", () => {
    const nodes = new Map([
      ["US", { jurisdictionKey: "US", name: "United States", jurisdictionType: "country" as const, country: "US" }],
      [
        "US-KS",
        {
          jurisdictionKey: "US-KS",
          name: "Kansas",
          jurisdictionType: "state" as const,
          country: "US",
          state: "KS",
          parentJurisdictionKey: "US",
        },
      ],
    ]);
    const path = buildJurisdictionPath(nodes.get("US-KS")!, nodes);
    expect(path.map((n) => n.jurisdictionKey)).toEqual(["US", "US-KS"]);
  });
});

describe("Phase 15A effective dating and rates", () => {
  it("checks effective ranges", () => {
    expect(isEffectiveOn({ effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }, "2026-06-01")).toBe(true);
    expect(isEffectiveOn({ effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }, "2027-01-01")).toBe(false);
    expect(validateEffectiveRange("2026-01-01", "2025-12-31").ok).toBe(false);
    expect(validateRatePercent(-1).ok).toBe(false);
    expect(validateRatePercent(8.975).ok).toBe(true);
  });

  it("combines component rates and detects overlap ambiguity", () => {
    expect(combinedRatePercent([{ ratePercent: 6.5 }, { ratePercent: 1.25 }])).toBe(7.75);
    const overlap = findOverlappingRateComponents(
      [
        {
          componentType: "state",
          jurisdictionKey: "US-KS",
          ratePercent: 6.5,
          effectiveFrom: "2026-01-01",
        },
        {
          componentType: "state",
          jurisdictionKey: "US-KS",
          ratePercent: 6.5,
          effectiveFrom: "2026-01-01",
        },
      ],
      "2026-06-01",
    );
    expect(overlap).not.toBeNull();
  });

  it("rounds deterministically in cents", () => {
    expect(taxAmountFromBasis(100, 8.875)).toBe(8.88);
    expect(applyRoundingPolicy([10.005, 10.005], "per_line")).toBe(20.02);
    expect(applyRoundingPolicy([10.005, 10.005], "per_document")).toBe(20.01);
  });
});

describe("Phase 15A tax categories", () => {
  it("resolves reference categories and normalizes keys", () => {
    expect(REFERENCE_TAX_CATEGORIES.length).toBeGreaterThanOrEqual(8);
    expect(resolveTaxCategory("equipment")?.name).toBe("Equipment");
    expect(normalizeTaxCategoryKey("General Merchandise")).toBe("general_merchandise");
    expect(normalizeTaxCategoryKey("")).toBe("other");
  });
});

describe("Phase 15A rule precedence", () => {
  it("prefers line override over exemption and org rules", () => {
    const line = resolveTaxRulePrecedence({
      transactionDate: "2026-06-01",
      jurisdictionKey: "US-KS",
      taxCategoryKey: "equipment",
      lineExplicitTreatment: "non_taxable",
      customerExemption: {
        status: "active",
        effectiveFrom: "2026-01-01",
        jurisdictionScope: ["*"],
        categoryScope: ["*"],
      },
      organizationRules: [
        {
          id: "r1",
          organizationId: "org",
          jurisdictionKey: "US-KS",
          taxCategoryKey: "equipment",
          treatment: "taxable",
          priority: 1,
          effectiveFrom: "2026-01-01",
          sourceKind: "organization_override",
        },
      ],
    });
    expect(line.treatment).toBe("non_taxable");
    expect(comparePrecedenceSources("line_override", "customer_exemption")).toBeLessThan(0);
  });

  it("returns needs_review when unresolved", () => {
    const unresolved = resolveTaxRulePrecedence({
      transactionDate: "2026-06-01",
      jurisdictionKey: "US-KS",
      taxCategoryKey: "service",
    });
    expect(unresolved.status).toBe("needs_review");
    expect(unresolved.needsReview).toBe(true);
  });
});

describe("Phase 15A calculation contract", () => {
  it("calculates line-level results without posting tax in foundation phase", () => {
    const result = calculateTax(
      {
        transactionDate: "2026-06-01",
        transactionType: "invoice",
        location: { transactionLocation: { state: "KS", country: "US" } },
        lines: [
          { lineKey: "1", description: "Equipment", lineAmount: 1000, taxCategory: "equipment" },
          {
            lineKey: "2",
            description: "Labor",
            lineAmount: 500,
            taxCategory: "labor",
            explicitTaxabilityOverride: "non_taxable",
          },
        ],
      },
      {
        organizationId: "org-1",
        roundingPolicy: "per_line",
        taxabilityRules: [],
        rateComponents: [],
        referenceCategoryTreatments: { "US-KS:equipment": "taxable" },
      },
    );
    expect(result.lineResults).toHaveLength(2);
    expect(result.taxTotal).toBe(0);
    expect(result.lineResults[0]!.taxableBasis).toBe(1000);
    expect(result.lineResults[1]!.nonTaxableBasis).toBe(500);
  });

  it("flags missing jurisdiction as needs review", () => {
    const result = calculateTax(
      {
        transactionDate: "2026-06-01",
        transactionType: "invoice",
        location: {},
        lines: [{ lineKey: "1", description: "Item", lineAmount: 100, taxCategory: "other" }],
      },
      {
        organizationId: "org-1",
        roundingPolicy: "per_line",
        taxabilityRules: [],
        rateComponents: [],
      },
    );
    expect(result.status).toBe("needs_review");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("Phase 15A inclusive/exclusive primitives", () => {
  it("splits exclusive and inclusive amounts", () => {
    expect(splitTaxExclusive(100, 8).taxAmount).toBe(8);
    expect(splitTaxInclusive(108, 8).basis).toBe(100);
    expect(splitTaxInclusive(108, 8).taxAmount).toBe(8);
  });
});

describe("Phase 15A immutability and period lock contracts", () => {
  it("blocks mutation of posted tax transactions", () => {
    expect(POSTED_TAX_HISTORY_IMMUTABLE).toBe(true);
    expect(() => assertTaxTransactionMutable({ isPosted: true })).toThrow(/immutable/i);
    expect(taxPostingBlockedByPeriodLock({
      transactionDate: "2026-05-15",
      periodEnd: "2026-05-31",
      periodStatus: "closed",
    })).toBe(true);
  });
});

describe("Phase 15A tenant isolation", () => {
  it("rejects cross-org references", () => {
    expect(rejectCrossOrgReference("org-a", "org-b")).toBe(true);
    expect(rejectCrossOrgReference("org-a", "org-a")).toBe(false);
    expect(() => assertSameOrganization("org-a", "org-b", "Account")).toThrow(/must belong/);
  });
});

describe("Phase 15A posting contract", () => {
  it("does not plan posting when needs review or missing payable account", () => {
    const calc = calculateTax(
      {
        transactionDate: "2026-06-01",
        transactionType: "invoice",
        location: { transactionLocation: { state: "KS", country: "US" } },
        lines: [{ lineKey: "1", description: "x", lineAmount: 10, taxCategory: "other" }],
      },
      {
        organizationId: "org",
        roundingPolicy: "per_line",
        taxabilityRules: [],
        rateComponents: [],
      },
    );
    expect(
      planTaxPosting({
        organizationId: "org",
        sourceType: "invoice",
        sourceId: "doc-1",
        transactionType: "sales_tax_collected",
        transactionDate: "2026-06-01",
        calculation: calc,
        salesTaxPayableAccountId: "",
      }).canPost,
    ).toBe(false);
  });
});

describe("Phase 15A readiness", () => {
  it("evaluates setup status deterministically", () => {
    const partial = evaluateTaxReadiness({
      settings: { salesTaxPayableAccountId: "acct-1", setupStatus: "not_configured" },
      registrations: [{ status: "pending" }],
      hasActiveRates: false,
    });
    expect(partial.status).toBe("needs_review");
    expect(ownerSetupStatusLabel("configured")).toBe("Configured");
  });
});
