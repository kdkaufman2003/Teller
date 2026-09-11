import { isEffectiveOn } from "../rates";
import type { StatePackTaxabilityRule, StateTaxPack } from "./types";

export type StatePackValidationIssue = {
  code: string;
  message: string;
  context?: Record<string, unknown>;
};

function hasDateOverlap(
  aFrom: string,
  aTo: string | null | undefined,
  bFrom: string,
  bTo: string | null | undefined,
): boolean {
  const aEnd = aTo ?? "9999-12-31";
  const bEnd = bTo ?? "9999-12-31";
  return aFrom <= bEnd && bFrom <= aEnd;
}

export function validateStateTaxPack(pack: StateTaxPack, asOf = "2026-06-01"): StatePackValidationIssue[] {
  const issues: StatePackValidationIssue[] = [];

  if (!pack.packId?.trim()) issues.push({ code: "MISSING_PACK_ID", message: "packId required" });
  if (!pack.version?.trim()) issues.push({ code: "MISSING_VERSION", message: "version required" });
  if (!pack.sourceReferences?.length) {
    issues.push({ code: "MISSING_SOURCE", message: "At least one source reference required" });
  }
  for (const ref of pack.sourceReferences ?? []) {
    if (!ref.agency?.trim() || !ref.document?.trim() || !ref.retrievedAt?.trim()) {
      issues.push({ code: "INCOMPLETE_SOURCE", message: "Source reference missing agency/document/retrievedAt" });
    }
  }

  const jurisdictionKeys = new Set(pack.jurisdictions.map((j) => j.jurisdictionKey));
  for (const jurisdiction of pack.jurisdictions) {
    if (jurisdiction.parentJurisdictionKey && !jurisdictionKeys.has(jurisdiction.parentJurisdictionKey) && jurisdiction.parentJurisdictionKey !== "US") {
      issues.push({
        code: "INVALID_PARENT_JURISDICTION",
        message: `Unknown parent jurisdiction ${jurisdiction.parentJurisdictionKey}`,
        context: { jurisdictionKey: jurisdiction.jurisdictionKey },
      });
    }
  }

  for (let i = 0; i < pack.rateComponents.length; i++) {
    for (let j = i + 1; j < pack.rateComponents.length; j++) {
      const a = pack.rateComponents[i]!;
      const b = pack.rateComponents[j]!;
      if (
        a.jurisdictionKey === b.jurisdictionKey &&
        a.componentType === b.componentType &&
        hasDateOverlap(a.effectiveFrom, a.effectiveTo, b.effectiveFrom, b.effectiveTo)
      ) {
        issues.push({
          code: "OVERLAPPING_RATE",
          message: `Overlapping rate components for ${a.jurisdictionKey}/${a.componentType}`,
          context: { a: a.effectiveFrom, b: b.effectiveFrom },
        });
      }
    }
    if (!pack.rateComponents[i]!.sourceCitation?.trim()) {
      issues.push({ code: "MISSING_RATE_SOURCE", message: "Rate component missing sourceCitation" });
    }
  }

  const ruleGroups = new Map<string, StatePackTaxabilityRule[]>();
  for (const rule of pack.taxabilityRules) {
    if (!rule.sourceCitation?.trim()) {
      issues.push({ code: "MISSING_RULE_SOURCE", message: "Taxability rule missing sourceCitation" });
    }
    const key = `${rule.jurisdictionKey}:${rule.taxCategoryKey}:${rule.priority}`;
    const group = ruleGroups.get(key) ?? [];
    group.push(rule);
    ruleGroups.set(key, group);
  }
  for (const [key, rules] of ruleGroups) {
    if (rules.length <= 1) continue;
    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        if (hasDateOverlap(rules[i]!.effectiveFrom, rules[i]!.effectiveTo, rules[j]!.effectiveFrom, rules[j]!.effectiveTo)) {
          issues.push({ code: "OVERLAPPING_RULE", message: `Overlapping taxability rules for ${key}` });
        }
      }
    }
  }

  const activeRates = pack.rateComponents.filter((component) => isEffectiveOn(component, asOf));
  if (activeRates.length === 0) {
    issues.push({ code: "NO_ACTIVE_RATES", message: "No active rate components for validation date" });
  }

  return issues;
}
