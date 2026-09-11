import { describe, expect, it } from "vitest";
import { calculateTax } from "./calculation/engine";
import type { TaxCalculationConfig, TaxCalculationInput } from "./calculation/types";
import {
  buildReferenceCategoryTreatments,
  getStateTaxPack,
  listStateTaxPacks,
  validateStateTaxPack,
} from "./state-packs";
import { mapHvacItemTypeToTaxCategory } from "./state-packs/industry/hvac-mapping";
import { resolveTaxLocationForStatePack } from "./state-packs/sourcing";
import { toStatePackProfile } from "./state-packs/registry";

const ORG = "00000000-0000-0000-0000-000000000101";

function moConfig(): TaxCalculationConfig {
  const pack = getStateTaxPack("MO-2026.1")!;
  return {
    organizationId: ORG,
    roundingPolicy: "per_line",
    taxabilityRules: pack.taxabilityRules.map((rule, index) => ({
      id: `mo-rule-${index}`,
      organizationId: ORG,
      jurisdictionKey: rule.jurisdictionKey,
      taxCategoryKey: rule.taxCategoryKey,
      treatment: rule.treatment,
      priority: rule.priority,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo ?? null,
      sourceKind: "reference_rule_set",
      ruleSetSlug: pack.slug,
    })),
    rateComponents: pack.rateComponents.map((component, index) => ({
      rateId: `mo-rate-${index}`,
      componentType: component.componentType,
      jurisdictionKey: component.jurisdictionKey,
      authorityId: null,
      ratePercent: component.ratePercent,
      effectiveFrom: component.effectiveFrom,
      effectiveTo: component.effectiveTo ?? null,
    })),
    statePackProfiles: { MO: toStatePackProfile(pack) },
    sellerLocation: { country: "US", state: "MO", city: "Springfield", locationKind: "seller" },
  };
}

function ksConfig(): TaxCalculationConfig {
  const pack = getStateTaxPack("KS-2026.1")!;
  return {
    organizationId: ORG,
    roundingPolicy: "per_line",
    taxabilityRules: pack.taxabilityRules.map((rule, index) => ({
      id: `ks-rule-${index}`,
      organizationId: ORG,
      jurisdictionKey: rule.jurisdictionKey,
      taxCategoryKey: rule.taxCategoryKey,
      treatment: rule.treatment,
      priority: rule.priority,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo ?? null,
      sourceKind: "reference_rule_set",
      ruleSetSlug: pack.slug,
    })),
    rateComponents: pack.rateComponents.map((component, index) => ({
      rateId: `ks-rate-${index}`,
      componentType: component.componentType,
      jurisdictionKey: component.jurisdictionKey,
      authorityId: null,
      ratePercent: component.ratePercent,
      effectiveFrom: component.effectiveFrom,
      effectiveTo: component.effectiveTo ?? null,
    })),
    statePackProfiles: { KS: toStatePackProfile(pack) },
    sellerLocation: { country: "US", state: "MO", city: "Springfield", locationKind: "seller" },
  };
}

describe("Phase 15H state packs", () => {
  it("recognizes Missouri and Kansas packs with version metadata", () => {
    const packs = listStateTaxPacks();
    expect(packs.some((pack) => pack.packId === "MO-2026.1")).toBe(true);
    expect(packs.some((pack) => pack.packId === "KS-2026.1")).toBe(true);
    for (const pack of packs) {
      expect(validateStateTaxPack(pack)).toEqual([]);
      expect(pack.sourceReferences.length).toBeGreaterThan(0);
      expect(pack.version).toMatch(/^(MO|KS)-2026\.1$/);
    }
  });

  it("MO origin sourcing uses seller location", () => {
    const resolved = resolveTaxLocationForStatePack(
      {
        sellerLocation: { country: "US", state: "MO", county: "GREENE" },
        shipToLocation: { country: "US", state: "KS", county: "JOCO" },
      },
      "origin_seller",
    );
    expect(resolved.jurisdictionKey).toBe("US-MO-GREENE");
    expect(resolved.source).toBe("seller");
  });

  it("KS destination sourcing uses ship-to over seller", () => {
    const resolved = resolveTaxLocationForStatePack(
      {
        sellerLocation: { country: "US", state: "MO" },
        shipToLocation: { country: "US", state: "KS", county: "FINNEY" },
      },
      "destination",
    );
    expect(resolved.jurisdictionKey).toBe("US-KS-FINNEY");
    expect(resolved.source).toBe("ship_to");
  });

  it("calculates Missouri state rate on equipment (4.225%)", () => {
    const result = calculateTax(
      {
        transactionDate: "2026-06-01",
        transactionType: "invoice",
        location: {
          sellerLocation: { country: "US", state: "MO" },
        },
        lines: [{ lineKey: "1", lineAmount: 1000, taxCategory: "equipment" }],
      },
      moConfig(),
    );
    expect(result.status).toBe("resolved");
    expect(result.taxTotal).toBe(42.25);
    expect(result.lineResults[0]?.trace.statePackVersion).toBe("MO-2026.1");
  });

  it("calculates Kansas Finney county combined rate (7.95%)", () => {
    const result = calculateTax(
      {
        transactionDate: "2026-06-01",
        transactionType: "invoice",
        location: {
          shipToLocation: { country: "US", state: "KS", county: "FINNEY" },
        },
        lines: [{ lineKey: "1", lineAmount: 1000, taxCategory: "equipment" }],
      },
      ksConfig(),
    );
    expect(result.status).toBe("resolved");
    expect(result.taxTotal).toBe(79.5);
  });

  it("unknown local jurisdiction returns needs_review", () => {
    const result = calculateTax(
      {
        transactionDate: "2026-06-01",
        transactionType: "invoice",
        location: {
          shipToLocation: { country: "US", state: "KS", county: "JOCO" },
        },
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
      },
      ksConfig(),
    );
    expect(result.status).toBe("needs_review");
    expect(result.reasonCodes).toContain("UNKNOWN_LOCAL_JURISDICTION");
  });

  it("cross-border uses destination Kansas not Missouri seller home", () => {
    const result = calculateTax(
      {
        transactionDate: "2026-06-01",
        transactionType: "invoice",
        location: {
          sellerLocation: { country: "US", state: "MO" },
          shipToLocation: { country: "US", state: "KS" },
        },
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
      },
      { ...ksConfig(), statePackProfiles: { ...ksConfig().statePackProfiles, MO: toStatePackProfile(getStateTaxPack("MO-2026.1")!) } },
    );
    expect(result.lineResults[0]?.jurisdictionKey).toBe("US-KS");
    expect(result.lineResults[0]?.trace.crossBorder).toBe(true);
  });

  it("HVAC fact-dependent item types require review", () => {
    const mapped = mapHvacItemTypeToTaxCategory("new_construction");
    expect(mapped.factDependent).toBe(true);
    const result = calculateTax(
      {
        transactionDate: "2026-06-01",
        transactionType: "invoice",
        location: { sellerLocation: { country: "US", state: "MO" } },
        lines: [{ lineKey: "1", lineAmount: 100, itemType: "new_construction" }],
      },
      { ...moConfig(), useIndustryHvacMapping: true },
    );
    expect(result.status).toBe("needs_review");
  });

  it("HVAC repair labor maps to generic category and MO pack returns needs_review", () => {
    const result = calculateTax(
      {
        transactionDate: "2026-06-01",
        transactionType: "invoice",
        location: { sellerLocation: { country: "US", state: "MO" } },
        lines: [{ lineKey: "1", lineAmount: 100, itemType: "repair_labor" }],
      },
      { ...moConfig(), useIndustryHvacMapping: true },
    );
    expect(result.lineResults[0]?.taxCategoryKey).toBe("labor");
    expect(result.status).toBe("needs_review");
  });

  it("organization override beats reference pack rule", () => {
    const config = moConfig();
    config.taxabilityRules.push({
      id: "org-override",
      organizationId: ORG,
      jurisdictionKey: "US-MO",
      taxCategoryKey: "labor",
      treatment: "non_taxable",
      priority: 10,
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
      sourceKind: "organization_override",
      ruleSetSlug: null,
    });
    const result = calculateTax(
      {
        transactionDate: "2026-06-01",
        transactionType: "invoice",
        location: { sellerLocation: { country: "US", state: "MO" } },
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "labor" }],
      },
      config,
    );
    expect(result.lineResults[0]?.treatment).toBe("non_taxable");
    expect(result.taxTotal).toBe(0);
  });

  it("reference treatments map is stable for historical version key", () => {
    const pack = getStateTaxPack("KS-2026.1")!;
    const treatments = buildReferenceCategoryTreatments(pack);
    expect(treatments["US-KS:equipment"]).toBe("taxable");
    expect(pack.version).toBe("KS-2026.1");
  });

  it("exact jurisdiction org rule beats prefix reference rule at same priority", () => {
    const config = ksConfig();
    config.taxabilityRules.push({
      id: "acceptance-exact",
      organizationId: ORG,
      jurisdictionKey: "US-KS-P15BTAX",
      taxCategoryKey: "equipment",
      treatment: "taxable",
      priority: 100,
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
      sourceKind: "organization_override",
      ruleSetSlug: null,
    });
    config.rateComponents.push({
      rateId: "acceptance-rate",
      componentType: "state",
      jurisdictionKey: "US-KS-P15BTAX",
      authorityId: null,
      ratePercent: 6.5,
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
    });
    const result = calculateTax(
      {
        transactionDate: "2026-06-01",
        transactionType: "invoice",
        location: { transactionLocation: { country: "US", state: "KS", county: "P15BTAX" } },
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
      },
      config,
    );
    expect(result.status).toBe("resolved");
    expect(result.taxTotal).toBe(6.5);
  });

  it("transaction location governs state pack when org seller is another state", () => {
    const config = ksConfig();
    const result = calculateTax(
      {
        transactionDate: "2026-06-01",
        transactionType: "invoice",
        location: { transactionLocation: { country: "US", state: "KS" } },
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
      },
      config,
    );
    expect(result.lineResults[0]?.jurisdictionKey).toBe("US-KS");
    expect(result.status).toBe("resolved");
    expect(result.taxTotal).toBe(6.5);
  });

  it("MO and KS packs coexist in multi-state config", () => {
    const mo = getStateTaxPack("MO-2026.1")!;
    const ks = getStateTaxPack("KS-2026.1")!;
    const config: TaxCalculationConfig = {
      organizationId: ORG,
      roundingPolicy: "per_line",
      taxabilityRules: [],
      rateComponents: [...mo.rateComponents, ...ks.rateComponents].map((component, index) => ({
        rateId: `multi-${index}`,
        componentType: component.componentType,
        jurisdictionKey: component.jurisdictionKey,
        authorityId: null,
        ratePercent: component.ratePercent,
        effectiveFrom: component.effectiveFrom,
        effectiveTo: component.effectiveTo ?? null,
      })),
      statePackProfiles: {
        MO: toStatePackProfile(mo),
        KS: toStatePackProfile(ks),
      },
    };
    const moResult = calculateTax(
      {
        transactionDate: "2026-06-01",
        transactionType: "invoice",
        location: { sellerLocation: { country: "US", state: "MO" } },
        lines: [{ lineKey: "mo", lineAmount: 100, taxCategory: "equipment" }],
      } satisfies TaxCalculationInput,
      {
        ...config,
        taxabilityRules: mo.taxabilityRules.map((rule, index) => ({
          id: `mo-${index}`,
          organizationId: ORG,
          jurisdictionKey: rule.jurisdictionKey,
          taxCategoryKey: rule.taxCategoryKey,
          treatment: rule.treatment,
          priority: rule.priority,
          effectiveFrom: rule.effectiveFrom,
          effectiveTo: rule.effectiveTo ?? null,
          sourceKind: "reference_rule_set",
          ruleSetSlug: mo.slug,
        })),
      },
    );
    expect(moResult.taxTotal).toBe(4.23);
  });
});
