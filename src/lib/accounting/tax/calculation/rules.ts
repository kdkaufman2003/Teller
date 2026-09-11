import { isEffectiveOn } from "../rates";
import { resolveTaxRulePrecedence, type TaxRulePrecedenceInput } from "../taxability";
import { TaxReviewReason } from "./reason-codes";
import type { TaxabilityRuleRecord, TaxDeterminationStatus, TaxTreatment } from "../types";

export type OrgRuleMatch =
  | { kind: "none" }
  | { kind: "single"; rule: TaxabilityRuleRecord }
  | { kind: "ambiguous"; rules: TaxabilityRuleRecord[] };

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

export function matchOrganizationTaxabilityRules(
  rules: TaxabilityRuleRecord[],
  jurisdictionKey: string,
  taxCategoryKey: string,
  asOf: string,
): OrgRuleMatch {
  const matches = rules
    .filter(
      (rule) =>
        jurisdictionRuleMatches(rule, jurisdictionKey) &&
        rule.taxCategoryKey === taxCategoryKey &&
        isEffectiveOn(rule, asOf),
    )
    .sort((a, b) => sortTaxabilityRuleCandidates(a, b, jurisdictionKey));

  if (matches.length === 0) return { kind: "none" };

  const exactMatches = matches.filter((rule) => rule.jurisdictionKey === jurisdictionKey);
  const candidates = exactMatches.length > 0 ? exactMatches : matches;

  const topPriority = candidates[0]!.priority;
  const topMatches = candidates.filter((rule) => rule.priority === topPriority);
  if (topMatches.length > 1) return { kind: "ambiguous", rules: topMatches };
  return { kind: "single", rule: candidates[0]! };
}

export type LineTaxabilityInput = Omit<TaxRulePrecedenceInput, "referenceRuleTreatment"> & {
  referenceRuleTreatment?: TaxTreatment | null;
};

export type LineTaxabilityResult = {
  treatment: TaxTreatment;
  status: TaxDeterminationStatus;
  source: string;
  ruleId?: string | null;
  reasonCodes: string[];
  zeroRateTaxable: boolean;
  trace: Record<string, unknown>;
};

export function resolveLineTaxability(input: LineTaxabilityInput): LineTaxabilityResult {
  const orgMatch = matchOrganizationTaxabilityRules(
    input.organizationRules ?? [],
    input.jurisdictionKey,
    input.taxCategoryKey,
    input.transactionDate,
  );

  const reasonCodes: string[] = [];

  if (orgMatch.kind === "ambiguous") {
    return {
      treatment: "needs_review",
      status: "needs_review",
      source: "ambiguous_organization_rule",
      reasonCodes: [TaxReviewReason.AMBIGUOUS_TAX_RULE],
      zeroRateTaxable: false,
      trace: { ambiguousRuleIds: orgMatch.rules.map((r) => r.id) },
    };
  }

  const precedence = resolveTaxRulePrecedence({
    ...input,
    organizationRules: orgMatch.kind === "single" ? [orgMatch.rule] : input.organizationRules ?? [],
  });

  if (precedence.needsReview && precedence.source === "unresolved") {
    reasonCodes.push(TaxReviewReason.NO_TAXABILITY_RULE);
  }

  return {
    treatment: precedence.treatment,
    status: precedence.status,
    source: precedence.source,
    ruleId: precedence.ruleKey ?? (orgMatch.kind === "single" ? orgMatch.rule.id : null),
    reasonCodes,
    zeroRateTaxable: precedence.treatment === "taxable",
    trace: {
      sourceKind: precedence.sourceKind,
      precedenceSource: precedence.source,
      ruleId: precedence.ruleKey,
    },
  };
}
