import { TaxReviewReason } from "../calculation/reason-codes";
import type { TaxExemptionRecord } from "../types";
import { ExemptionReason } from "./reason-codes";
import { categoryScopeMatches, jurisdictionScopeMatches } from "./scope";
import type {
  ExemptionResolutionResult,
  ParsedTaxExemption,
  TaxExemptionOrgPolicy,
} from "./types";
import { isExemptionDateValid } from "./validity";

export type ResolveCustomerExemptionInput = {
  exemptions: ParsedTaxExemption[];
  transactionDate: string;
  jurisdictionKey: string;
  taxCategoryKey: string;
  orgPolicy?: TaxExemptionOrgPolicy;
};

function isCalculableActive(exemption: ParsedTaxExemption, transactionDate: string): boolean {
  if (exemption.status !== "active") return false;
  if (exemption.lifecycleStatus === "revoked" || exemption.lifecycleStatus === "rejected") return false;
  if (exemption.lifecycleStatus === "draft" || exemption.lifecycleStatus === "needs_review") return false;
  return isExemptionDateValid(exemption, transactionDate);
}

function validateCompleteness(
  exemption: ParsedTaxExemption,
  orgPolicy?: TaxExemptionOrgPolicy,
): string[] {
  const codes: string[] = [];
  if (orgPolicy?.requireCertificateNumber && !exemption.certificateNumber?.trim()) {
    codes.push(ExemptionReason.INCOMPLETE_EXEMPTION);
  }
  if (orgPolicy?.requireCertificateOnFile && !exemption.certificateOnFile) {
    codes.push(ExemptionReason.INCOMPLETE_EXEMPTION);
  }
  if (exemption.jurisdictionScope.length === 0) {
    codes.push(ExemptionReason.INCOMPLETE_EXEMPTION);
  }
  return codes;
}

/** Converts a parsed exemption into the shape consumed by taxability precedence. */
export function toTaxabilityExemption(exemption: ParsedTaxExemption): Pick<
  TaxExemptionRecord,
  "id" | "status" | "effectiveFrom" | "effectiveTo" | "jurisdictionScope" | "categoryScope"
> {
  return {
    id: exemption.id,
    status: "active",
    effectiveFrom: exemption.effectiveFrom,
    effectiveTo: exemption.effectiveTo,
    jurisdictionScope: exemption.jurisdictionScope,
    categoryScope: exemption.categoryScope,
  };
}

/**
 * Deterministic customer exemption resolver.
 * Does not pick arbitrarily when multiple certificates qualify.
 */
export function resolveCustomerExemption(input: ResolveCustomerExemptionInput): ExemptionResolutionResult {
  const { exemptions, transactionDate, jurisdictionKey, taxCategoryKey, orgPolicy } = input;
  const warnings: string[] = [];
  const reasonCodes: string[] = [];

  const candidates = exemptions.filter((exemption) => {
    if (!isCalculableActive(exemption, transactionDate)) return false;
    if (!jurisdictionScopeMatches(exemption.jurisdictionScope, jurisdictionKey)) return false;
    if (!categoryScopeMatches(exemption.categoryScope, taxCategoryKey)) return false;
    const incomplete = validateCompleteness(exemption, orgPolicy);
    if (incomplete.length > 0) {
      reasonCodes.push(...incomplete);
      return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    const scoped = exemptions.filter((exemption) => {
      const jurisdictionOk = jurisdictionScopeMatches(exemption.jurisdictionScope, jurisdictionKey);
      const categoryOk = categoryScopeMatches(exemption.categoryScope, taxCategoryKey);
      return jurisdictionOk && categoryOk;
    });

    for (const exemption of scoped) {
      if (exemption.lifecycleStatus === "needs_review" || exemption.reviewStatus === "needs_review") {
        reasonCodes.push(ExemptionReason.EXEMPTION_NEEDS_REVIEW);
        return { status: "needs_review", exemption: null, reasonCodes: [...new Set(reasonCodes)], warnings };
      }
      const incomplete = validateCompleteness(exemption, orgPolicy);
      if (incomplete.length > 0) {
        reasonCodes.push(...incomplete);
        return { status: "needs_review", exemption: null, reasonCodes: [...new Set(reasonCodes)], warnings };
      }
    }

    // Expired/revoked/out-of-scope certificates fall through to normal tax rules — not needs_review.
    return { status: "none", exemption: null, reasonCodes: [], warnings };
  }

  if (candidates.length > 1) {
    reasonCodes.push(ExemptionReason.AMBIGUOUS_EXEMPTION);
    reasonCodes.push(TaxReviewReason.INVALID_EXEMPTION);
    return {
      status: "ambiguous",
      exemption: null,
      reasonCodes,
      warnings: ["Multiple qualifying exemption certificates match this transaction"],
    };
  }

  const matched = candidates[0]!;
  if (matched.metadata.duplicateWarning) {
    warnings.push(ExemptionReason.DUPLICATE_EXEMPTION);
  }

  return {
    status: "valid",
    exemption: matched,
    reasonCodes: [],
    warnings,
  };
}
