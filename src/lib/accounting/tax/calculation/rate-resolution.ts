import { combinedRatePercent, findOverlappingRateComponents, isEffectiveOn } from "../rates";
import { TaxReviewReason } from "./reason-codes";
import type { TaxRateComponentRecord, TaxRateComponentType } from "../types";

export type ResolvedRateComponent = TaxRateComponentRecord & {
  rateId?: string | null;
  authorityId?: string | null;
};

export type RateResolutionResult =
  | {
      ok: true;
      components: ResolvedRateComponent[];
      combinedRatePercent: number;
    }
  | {
      ok: false;
      reasonCodes: string[];
      components: ResolvedRateComponent[];
    };

function dedupeIdenticalComponents(components: ResolvedRateComponent[]): ResolvedRateComponent[] {
  const seen = new Map<string, ResolvedRateComponent>();
  for (const component of components) {
    const key = `${component.componentType}:${component.jurisdictionKey}:${component.ratePercent}:${component.effectiveFrom}:${component.effectiveTo ?? ""}`;
    if (!seen.has(key)) seen.set(key, component);
  }
  return [...seen.values()];
}

function componentMatchesJurisdiction(component: ResolvedRateComponent, jurisdictionKey: string): boolean {
  if (component.jurisdictionKey === jurisdictionKey) return true;
  return jurisdictionKey.startsWith(`${component.jurisdictionKey}-`) && component.jurisdictionKey.length > 0;
}

function componentSpecificity(component: ResolvedRateComponent, jurisdictionKey: string): number {
  return component.jurisdictionKey === jurisdictionKey ? 2 : 1;
}

export function resolveRateComponents(
  allComponents: ResolvedRateComponent[],
  jurisdictionKey: string,
  asOf: string,
): RateResolutionResult {
  const scoped = allComponents.filter((component) => componentMatchesJurisdiction(component, jurisdictionKey));

  const active = dedupeIdenticalComponents(scoped.filter((component) => isEffectiveOn(component, asOf)));
  if (active.length === 0) {
    return { ok: false, reasonCodes: [TaxReviewReason.NO_ACTIVE_TAX_RATE], components: [] };
  }

  const exactMatches = active.filter((component) => component.jurisdictionKey === jurisdictionKey);
  const overlapCandidates = exactMatches.length > 0 ? exactMatches : active;
  const overlap = findOverlappingRateComponents(overlapCandidates, asOf);
  if (overlap) {
    return {
      ok: false,
      reasonCodes: [TaxReviewReason.AMBIGUOUS_TAX_RATE],
      components: overlap,
    };
  }

  const byType = new Map<TaxRateComponentType, ResolvedRateComponent>();
  for (const component of active) {
    const existing = byType.get(component.componentType);
    if (!existing) {
      byType.set(component.componentType, component);
      continue;
    }
    const nextSpecificity = componentSpecificity(component, jurisdictionKey);
    const existingSpecificity = componentSpecificity(existing, jurisdictionKey);
    if (
      nextSpecificity > existingSpecificity ||
      (nextSpecificity === existingSpecificity && component.ratePercent > existing.ratePercent)
    ) {
      byType.set(component.componentType, component);
    }
  }

  const components = [...byType.values()].sort((a, b) => a.componentType.localeCompare(b.componentType));
  return {
    ok: true,
    components,
    combinedRatePercent: combinedRatePercent(components),
  };
}
