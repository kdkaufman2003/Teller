import { isEffectiveOn } from "./rates";
import type {
  TaxDeterminationStatus,
  TaxExemptionRecord,
  TaxRuleSourceKind,
  TaxTreatment,
  TaxabilityRuleRecord,
} from "./types";

export type TaxRulePrecedenceInput = {
  transactionDate: string;
  jurisdictionKey: string;
  taxCategoryKey: string;
  lineExplicitTreatment?: TaxTreatment | null;
  customerExemption?: Pick<TaxExemptionRecord, "status" | "effectiveFrom" | "effectiveTo" | "jurisdictionScope" | "categoryScope"> | null;
  organizationRules?: TaxabilityRuleRecord[];
  industryDefaultTreatment?: TaxTreatment | null;
  referenceRuleTreatment?: TaxTreatment | null;
};

export type TaxRulePrecedenceResult = {
  treatment: TaxTreatment;
  status: TaxDeterminationStatus;
  source: string;
  sourceKind?: TaxRuleSourceKind;
  ruleKey?: string | null;
  needsReview: boolean;
};

const SOURCE_RANK: Record<string, number> = {
  line_override: 0,
  customer_exemption: 1,
  organization_override: 2,
  industry_profile: 3,
  reference_rule_set: 4,
};

function exemptionApplies(
  exemption: NonNullable<TaxRulePrecedenceInput["customerExemption"]>,
  jurisdictionKey: string,
  taxCategoryKey: string,
  asOf: string,
): boolean {
  if (exemption.status !== "active") return false;
  if (!isEffectiveOn(exemption, asOf)) return false;
  const jurisdictions = exemption.jurisdictionScope ?? [];
  const categories = exemption.categoryScope ?? [];
  const jurisdictionOk =
    jurisdictions.length === 0 || jurisdictions.includes("*") || jurisdictions.includes(jurisdictionKey);
  const categoryOk =
    categories.length === 0 || categories.includes("*") || categories.includes(taxCategoryKey);
  return jurisdictionOk && categoryOk;
}

function jurisdictionRuleMatches(rule: TaxabilityRuleRecord, jurisdictionKey: string): boolean {
  if (rule.jurisdictionKey === jurisdictionKey) return true;
  return jurisdictionKey.startsWith(`${rule.jurisdictionKey}-`) && rule.jurisdictionKey.length > 0;
}

function sortTaxabilityRuleCandidates(a: TaxabilityRuleRecord, b: TaxabilityRuleRecord, jurisdictionKey: string): number {
  const aExact = a.jurisdictionKey === jurisdictionKey ? 1 : 0;
  const bExact = b.jurisdictionKey === jurisdictionKey ? 1 : 0;
  return (
    a.priority - b.priority ||
    bExact - aExact ||
    b.jurisdictionKey.length - a.jurisdictionKey.length ||
    a.effectiveFrom.localeCompare(b.effectiveFrom)
  );
}

function pickOrgRule(
  rules: TaxabilityRuleRecord[],
  jurisdictionKey: string,
  taxCategoryKey: string,
  asOf: string,
): TaxabilityRuleRecord | null {
  const matches = rules
    .filter(
      (rule) =>
        jurisdictionRuleMatches(rule, jurisdictionKey) &&
        rule.taxCategoryKey === taxCategoryKey &&
        isEffectiveOn(rule, asOf),
    )
    .sort((a, b) => sortTaxabilityRuleCandidates(a, b, jurisdictionKey));

  const exactMatches = matches.filter((rule) => rule.jurisdictionKey === jurisdictionKey);
  const candidates = exactMatches.length > 0 ? exactMatches : matches;
  return candidates[0] ?? null;
}

export function resolveTaxRulePrecedence(input: TaxRulePrecedenceInput): TaxRulePrecedenceResult {
  const asOf = input.transactionDate;

  if (input.lineExplicitTreatment) {
    return toResult(input.lineExplicitTreatment, "line_override", undefined, input.lineExplicitTreatment);
  }

  if (input.customerExemption && exemptionApplies(input.customerExemption, input.jurisdictionKey, input.taxCategoryKey, asOf)) {
    return toResult("exempt", "customer_exemption", "organization_override");
  }

  const orgRule = pickOrgRule(input.organizationRules ?? [], input.jurisdictionKey, input.taxCategoryKey, asOf);
  if (orgRule) {
    return toResult(orgRule.treatment, "organization_rule", orgRule.sourceKind, orgRule.treatment, orgRule.id);
  }

  if (input.industryDefaultTreatment) {
    return toResult(input.industryDefaultTreatment, "industry_profile", "industry_profile", input.industryDefaultTreatment);
  }

  if (input.referenceRuleTreatment) {
    return toResult(input.referenceRuleTreatment, "reference_rule_set", "reference_rule_set", input.referenceRuleTreatment);
  }

  return {
    treatment: "needs_review",
    status: "needs_review",
    source: "unresolved",
    needsReview: true,
  };
}

function toResult(
  treatment: TaxTreatment,
  source: string,
  sourceKind?: TaxRuleSourceKind,
  resolvedTreatment: TaxTreatment = treatment,
  ruleKey?: string | null,
): TaxRulePrecedenceResult {
  const needsReview = resolvedTreatment === "needs_review";
  const status: TaxDeterminationStatus = needsReview
    ? "needs_review"
    : resolvedTreatment === "exempt"
      ? "exempt"
      : resolvedTreatment === "non_taxable"
        ? "non_taxable"
        : "resolved";
  return { treatment: resolvedTreatment, status, source, sourceKind, ruleKey, needsReview };
}

export function comparePrecedenceSources(a: string, b: string): number {
  return (SOURCE_RANK[a] ?? 99) - (SOURCE_RANK[b] ?? 99);
}
