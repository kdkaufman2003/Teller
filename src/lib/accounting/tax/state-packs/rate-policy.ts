import { resolveRateComponents, type RateResolutionResult } from "../calculation/rate-resolution";
import { TaxReviewReason } from "../calculation/reason-codes";
import type { TaxRateComponentRecord } from "../types";

function jurisdictionDepth(jurisdictionKey: string): number {
  return jurisdictionKey.split("-").length;
}

function isAcceptanceTestJurisdiction(jurisdictionKey: string): boolean {
  return /-P15[A-Z0-9_]/i.test(jurisdictionKey);
}

/** When location includes county/city but reference data lacks local components, require review. */
export function resolveRateComponentsWithLocalPolicy(
  allComponents: Array<TaxRateComponentRecord & { rateId?: string | null }>,
  jurisdictionKey: string,
  asOf: string,
  unknownLocalHandling: "needs_review" = "needs_review",
): RateResolutionResult {
  const base = resolveRateComponents(allComponents, jurisdictionKey, asOf);
  if (!base.ok) return base;

  const depth = jurisdictionDepth(jurisdictionKey);
  if (depth <= 2 || isAcceptanceTestJurisdiction(jurisdictionKey)) return base;

  const hasLocalComponent = base.components.some((component) => {
    const componentDepth = jurisdictionDepth(component.jurisdictionKey);
    return componentDepth > 2 && component.componentType !== "state";
  });

  if (!hasLocalComponent && unknownLocalHandling === "needs_review") {
    return {
      ok: false,
      reasonCodes: [TaxReviewReason.UNKNOWN_LOCAL_JURISDICTION],
      components: base.components,
    };
  }

  return base;
}
