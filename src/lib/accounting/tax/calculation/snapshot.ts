import { TAX_ENGINE_VERSION } from "./types";
import type { TaxCalculationLineResult, TaxCalculationResult } from "./types";

export type DeterminationSnapshotPayload = {
  organizationId: string;
  documentId?: string | null;
  lineId?: string | null;
  transactionDate: string;
  taxCategoryKey?: string | null;
  jurisdictionKey?: string | null;
  determinationStatus: string;
  taxableBasis: number;
  taxAmount: number;
  ratePercent?: number | null;
  ruleSetSlug?: string | null;
  ruleKey?: string | null;
  exemptionId?: string | null;
  components: unknown[];
  precedenceTrace: Record<string, unknown>;
  metadata: {
    engineVersion: string;
    lineKey: string;
    reasonCodes: string[];
    zeroRateTaxable: boolean;
    exemptionCertificateType?: string | null;
    exemptionJurisdictionScope?: string[];
    exemptionCategoryScope?: string[];
    exemptionEffectiveFrom?: string | null;
    exemptionEffectiveTo?: string | null;
  };
};

export function buildLineDeterminationSnapshot(
  organizationId: string,
  transactionDate: string,
  line: TaxCalculationLineResult,
  result: TaxCalculationResult,
  source?: { documentId?: string | null; lineId?: string | null },
): DeterminationSnapshotPayload {
  return {
    organizationId,
    documentId: source?.documentId ?? line.lineId ?? null,
    lineId: source?.lineId ?? line.lineId ?? null,
    transactionDate,
    taxCategoryKey: line.taxCategoryKey,
    jurisdictionKey: line.jurisdictionKey,
    determinationStatus: line.determinationStatus,
    taxableBasis: line.taxableBasis,
    taxAmount: line.taxAmount,
    ratePercent: line.combinedRatePercent,
    ruleKey: typeof line.trace.ruleId === "string" ? line.trace.ruleId : null,
    exemptionId: line.exemptionId ?? null,
    components: line.components,
    precedenceTrace: {
      ...line.trace,
      precedenceSource: line.precedenceSource,
      documentStatus: result.status,
      locationSource: result.determinationMetadata.locationSource,
      exemptionJurisdictionScope: line.exemptionJurisdictionScope,
      exemptionCategoryScope: line.exemptionCategoryScope,
    },
    metadata: {
      engineVersion: result.determinationMetadata.engineVersion,
      lineKey: line.lineKey,
      reasonCodes: line.reasonCodes,
      zeroRateTaxable: line.zeroRateTaxable,
      exemptionCertificateType: line.exemptionCertificateType ?? null,
      exemptionJurisdictionScope: line.exemptionJurisdictionScope,
      exemptionCategoryScope: line.exemptionCategoryScope,
      exemptionEffectiveFrom:
        typeof line.trace.exemptionEffectiveFrom === "string" ? line.trace.exemptionEffectiveFrom : null,
      exemptionEffectiveTo:
        typeof line.trace.exemptionEffectiveTo === "string" ? line.trace.exemptionEffectiveTo : null,
    },
  };
}
