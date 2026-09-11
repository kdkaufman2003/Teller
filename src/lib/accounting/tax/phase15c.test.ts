import { describe, expect, it } from "vitest";
import { calculateTax } from "./calculation/engine";
import { buildLineDeterminationSnapshot } from "./calculation/snapshot";
import { ExemptionReason } from "./exemptions/reason-codes";
import { parseTaxExemptionRow } from "./exemptions/parse";
import { resolveCustomerExemption } from "./exemptions/resolver";
import { categoryScopeMatches, jurisdictionScopeMatches } from "./exemptions/scope";
import { isExemptionDateValid, expirationWarningLevel } from "./exemptions/validity";
import type { ParsedTaxExemption, TaxExemptionRow } from "./exemptions/types";
import type { TaxCalculationConfig, TaxCalculationInput } from "./calculation/types";

const ORG = "org-15c";

function exemption(overrides: Partial<TaxExemptionRow> & { metadata?: Record<string, unknown> }): ParsedTaxExemption {
  return parseTaxExemptionRow({
    id: overrides.id ?? "ex-1",
    organization_id: ORG,
    party_id: "party-1",
    certificate_number: overrides.certificate_number ?? "CERT-100",
    certificate_on_file: overrides.certificate_on_file ?? true,
    jurisdiction_scope: overrides.jurisdiction_scope ?? ["US-KS"],
    category_scope: overrides.category_scope ?? ["equipment"],
    status: overrides.status ?? "active",
    effective_from: overrides.effective_from ?? "2026-01-01",
    effective_to: overrides.effective_to ?? "2026-12-31",
    metadata: overrides.metadata ?? { certificateType: "resale", reviewStatus: "approved" },
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
}

function baseConfig(exemptions: ParsedTaxExemption[]): TaxCalculationConfig {
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
    ],
    partyExemptions: exemptions,
  };
}

describe("Phase 15C exemption validity", () => {
  it("accepts active valid exemption on transaction date", () => {
    const ex = exemption({});
    expect(isExemptionDateValid(ex, "2026-06-01")).toBe(true);
    expect(resolveCustomerExemption({
      exemptions: [ex],
      transactionDate: "2026-06-01",
      jurisdictionKey: "US-KS",
      taxCategoryKey: "equipment",
    }).status).toBe("valid");
  });

  it("does not apply future-dated exemption", () => {
    const ex = exemption({ effective_from: "2026-07-01" });
    const result = resolveCustomerExemption({
      exemptions: [ex],
      transactionDate: "2026-06-01",
      jurisdictionKey: "US-KS",
      taxCategoryKey: "equipment",
    });
    expect(result.status).toBe("none");
  });

  it("does not apply expired exemption", () => {
    const ex = exemption({ effective_to: "2026-05-31", status: "expired" });
    const result = resolveCustomerExemption({
      exemptions: [ex],
      transactionDate: "2026-06-01",
      jurisdictionKey: "US-KS",
      taxCategoryKey: "equipment",
    });
    expect(result.status).toBe("none");
  });

  it("rejects revoked exemption after revocation date", () => {
    const ex = exemption({
      status: "inactive",
      metadata: { certificateType: "resale", reviewStatus: "approved", revokedEffectiveFrom: "2026-06-01" },
    });
    expect(isExemptionDateValid(ex, "2026-06-15")).toBe(false);
    const result = resolveCustomerExemption({
      exemptions: [ex],
      transactionDate: "2026-06-15",
      jurisdictionKey: "US-KS",
      taxCategoryKey: "equipment",
    });
    expect(result.status).not.toBe("valid");
  });

  it("does not apply rejected exemption", () => {
    const ex = exemption({
      metadata: { certificateType: "resale", reviewStatus: "rejected", rejectedAt: "2026-01-01" },
    });
    const result = resolveCustomerExemption({
      exemptions: [ex],
      transactionDate: "2026-06-01",
      jurisdictionKey: "US-KS",
      taxCategoryKey: "equipment",
    });
    expect(result.status).toBe("none");
  });

  it("returns needs_review for incomplete certificate metadata", () => {
    const ex = exemption({
      metadata: { certificateType: "resale", reviewStatus: "needs_review" },
    });
    const result = resolveCustomerExemption({
      exemptions: [ex],
      transactionDate: "2026-06-01",
      jurisdictionKey: "US-KS",
      taxCategoryKey: "equipment",
    });
    expect(result.status).toBe("needs_review");
    expect(result.reasonCodes).toContain(ExemptionReason.EXEMPTION_NEEDS_REVIEW);
  });

  it("warns when certificate expires within 30 days", () => {
    const ex = exemption({ effective_to: "2026-06-20" });
    expect(expirationWarningLevel(ex, "2026-06-01")).toBe("expires_within_30_days");
  });
});

describe("Phase 15C exemption scope", () => {
  it("matches jurisdiction and parent prefix", () => {
    expect(jurisdictionScopeMatches(["US-KS"], "US-KS-JOCO")).toBe(true);
    expect(jurisdictionScopeMatches(["US-MO"], "US-KS")).toBe(false);
  });

  it("matches category scope and wildcard", () => {
    expect(categoryScopeMatches(["*"], "equipment")).toBe(true);
    expect(categoryScopeMatches(["labor"], "equipment")).toBe(false);
  });

  it("applies all-category exemption scope", () => {
    const result = resolveCustomerExemption({
      exemptions: [exemption({ category_scope: ["*"] })],
      transactionDate: "2026-06-01",
      jurisdictionKey: "US-KS",
      taxCategoryKey: "labor",
    });
    expect(result.status).toBe("valid");
  });

  it("rejects wrong jurisdiction scope", () => {
    const result = resolveCustomerExemption({
      exemptions: [exemption({ jurisdiction_scope: ["US-MO"] })],
      transactionDate: "2026-06-01",
      jurisdictionKey: "US-KS",
      taxCategoryKey: "equipment",
    });
    expect(result.status).toBe("none");
  });

  it("rejects wrong category scope", () => {
    const result = resolveCustomerExemption({
      exemptions: [exemption({ category_scope: ["labor"] })],
      transactionDate: "2026-06-01",
      jurisdictionKey: "US-KS",
      taxCategoryKey: "equipment",
    });
    expect(result.status).toBe("none");
  });
});

describe("Phase 15C precedence and calculator integration", () => {
  const input: TaxCalculationInput = {
    transactionDate: "2026-06-01",
    transactionType: "invoice",
    location: { transactionLocation: { country: "US", state: "KS" } },
    customer: { partyId: "party-1" },
    lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
  };

  it("returns exempt line when valid exemption applies", () => {
    const result = calculateTax(input, baseConfig([exemption({})]));
    expect(result.lineResults[0]!.treatment).toBe("exempt");
    expect(result.lineResults[0]!.taxAmount).toBe(0);
    expect(result.lineResults[0]!.exemptionId).toBe("ex-1");
    expect(result.lineResults[0]!.precedenceSource).toBe("customer_exemption");
  });

  it("prefers explicit override over exemption", () => {
    const result = calculateTax(
      {
        ...input,
        lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment", explicitTaxabilityOverride: "taxable" }],
      },
      baseConfig([exemption({})]),
    );
    expect(result.lineResults[0]!.treatment).toBe("taxable");
    expect(result.lineResults[0]!.taxAmount).toBe(6.5);
  });

  it("falls through to taxable when exemption expired", () => {
    const result = calculateTax(
      input,
      baseConfig([exemption({ effective_to: "2026-05-01", status: "expired" })]),
    );
    expect(result.lineResults[0]!.treatment).toBe("taxable");
    expect(result.lineResults[0]!.taxAmount).toBe(6.5);
  });
});

describe("Phase 15C ambiguity and snapshot metadata", () => {
  it("surfaces duplicate warning on otherwise valid exemption", () => {
    const result = resolveCustomerExemption({
      exemptions: [exemption({ metadata: { certificateType: "resale", reviewStatus: "approved", duplicateWarning: true } })],
      transactionDate: "2026-06-01",
      jurisdictionKey: "US-KS",
      taxCategoryKey: "equipment",
    });
    expect(result.status).toBe("valid");
    expect(result.warnings).toContain(ExemptionReason.DUPLICATE_EXEMPTION);
  });

  it("returns needs_review for ambiguous exemptions", () => {
    const result = resolveCustomerExemption({
      exemptions: [exemption({ id: "a" }), exemption({ id: "b", certificate_number: "CERT-200" })],
      transactionDate: "2026-06-01",
      jurisdictionKey: "US-KS",
      taxCategoryKey: "equipment",
    });
    expect(result.status).toBe("ambiguous");
    expect(result.reasonCodes).toContain(ExemptionReason.AMBIGUOUS_EXEMPTION);
  });

  it("preserves exemption metadata in determination snapshot", () => {
    const ex = exemption({});
    const input: TaxCalculationInput = {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS" } },
      customer: { partyId: "party-1" },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    };
    const result = calculateTax(input, baseConfig([ex]));
    const snapshot = buildLineDeterminationSnapshot(ORG, input.transactionDate, result.lineResults[0]!, result);
    expect(snapshot.exemptionId).toBeTruthy();
    expect(snapshot.metadata.exemptionCertificateType).toBe("resale");
  });

  it("keeps historical snapshot unchanged when exemption later expires", () => {
    const historicalSnapshot = {
      exemptionId: "ex-hist",
      metadata: { exemptionCertificateType: "resale", exemptionEffectiveTo: "2026-12-31" },
      taxAmount: 0,
      determinationStatus: "exempt",
    };
    const laterExpired = exemption({ id: "ex-hist", effective_to: "2026-05-01", status: "expired" });
    expect(isExemptionDateValid(laterExpired, "2026-06-01")).toBe(false);
    expect(historicalSnapshot.exemptionId).toBe("ex-hist");
    expect(historicalSnapshot.taxAmount).toBe(0);
  });
});

describe("Phase 15C tenant isolation (in-memory)", () => {
  it("uses only exemptions supplied for the org config", () => {
    const orgA = baseConfig([exemption({ id: "a", organization_id: ORG })]);
    const orgB = baseConfig([
      parseTaxExemptionRow({
        ...({
          id: "b",
          organization_id: "org-b",
          party_id: "party-b",
          certificate_number: "X",
          certificate_on_file: true,
          jurisdiction_scope: ["US-KS"],
          category_scope: ["*"],
          status: "active",
          effective_from: "2026-01-01",
          effective_to: null,
          metadata: { certificateType: "government", reviewStatus: "approved" },
          created_by: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        } satisfies TaxExemptionRow),
      }),
    ]);
    const input: TaxCalculationInput = {
      transactionDate: "2026-06-01",
      transactionType: "invoice",
      location: { transactionLocation: { country: "US", state: "KS" } },
      customer: { partyId: "party-1" },
      lines: [{ lineKey: "1", lineAmount: 100, taxCategory: "equipment" }],
    };
    const resultA = calculateTax(input, orgA);
    const resultB = calculateTax({ ...input, customer: { partyId: "party-b" } }, orgB);
    expect(resultA.lineResults[0]!.exemptionId).toBe("a");
    expect(resultB.lineResults[0]!.exemptionId).toBe("b");
  });
});
