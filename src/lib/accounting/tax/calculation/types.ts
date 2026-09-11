import type { ParsedTaxExemption, TaxExemptionOrgPolicy } from "../exemptions/types";
import type {
  TaxDeterminationStatus,
  TaxExemptionRecord,
  TaxLocationInput,
  TaxRateComponentRecord,
  TaxRoundingPolicy,
  TaxTreatment,
  TaxabilityRuleRecord,
} from "../types";
import type { StatePackProfile } from "../state-packs/types";
import type { TaxReviewReasonCode } from "./reason-codes";
import type { TaxLocationSources } from "./location";

export const TAX_ENGINE_VERSION = "teller_tax_engine_v1";

export type TaxCalculationMode = "exclusive" | "inclusive";

export type TaxCalculationLineInput = {
  lineId?: string | null;
  lineKey: string;
  description?: string;
  quantity?: number;
  unitAmount?: number;
  lineAmount?: number;
  taxCategory?: string | null;
  itemType?: string | null;
  explicitTaxabilityOverride?: TaxTreatment | null;
  locationOverride?: TaxLocationInput | null;
  taxInclusive?: boolean;
};

export type TaxCalculationCustomerInput = {
  partyId?: string | null;
  exemption?: Pick<
    TaxExemptionRecord,
    "id" | "status" | "effectiveFrom" | "effectiveTo" | "jurisdictionScope" | "categoryScope"
  > | null;
};

export type TaxCalculationInput = {
  transactionDate: string;
  transactionType: "invoice" | "credit_memo" | "bill" | "refund" | "other";
  mode?: TaxCalculationMode;
  location: TaxLocationSources;
  customer?: TaxCalculationCustomerInput | null;
  lines: TaxCalculationLineInput[];
  explicitDocumentOverride?: TaxTreatment | null;
};

export type TaxComponentResult = TaxRateComponentRecord & {
  rateId?: string | null;
  taxableBasis: number;
  taxAmount: number;
};

export type TaxCalculationLineResult = {
  lineId?: string | null;
  lineKey: string;
  taxCategoryKey: string | null;
  determinationStatus: TaxDeterminationStatus;
  treatment: TaxTreatment;
  taxableBasis: number;
  nonTaxableBasis: number;
  exemptBasis: number;
  taxAmount: number;
  jurisdictionKey: string | null;
  combinedRatePercent: number | null;
  zeroRateTaxable: boolean;
  components: TaxComponentResult[];
  warnings: string[];
  reasonCodes: TaxReviewReasonCode[];
  precedenceSource: string;
  trace: Record<string, unknown>;
  exemptionId?: string | null;
  exemptionCertificateType?: string | null;
  exemptionJurisdictionScope?: string[];
  exemptionCategoryScope?: string[];
};

export type TaxCalculationResult = {
  status: TaxDeterminationStatus;
  taxableSubtotal: number;
  nonTaxableSubtotal: number;
  exemptSubtotal: number;
  taxTotal: number;
  lineResults: TaxCalculationLineResult[];
  jurisdictionComponents: TaxComponentResult[];
  warnings: string[];
  reasonCodes: TaxReviewReasonCode[];
  determinationMetadata: {
    engineVersion: typeof TAX_ENGINE_VERSION;
    resolvedLineCount: number;
    needsReviewLineCount: number;
    roundingPolicy: TaxRoundingPolicy;
    locationSource: string | null;
    primaryJurisdictionKey: string | null;
  };
};

export type TaxCalculationConfig = {
  organizationId: string;
  roundingPolicy: TaxRoundingPolicy;
  taxabilityRules: TaxabilityRuleRecord[];
  rateComponents: Array<TaxRateComponentRecord & { rateId?: string | null }>;
  industryCategoryTreatments?: Record<string, TaxTreatment>;
  referenceCategoryTreatments?: Record<string, TaxTreatment>;
  sellerLocation?: TaxLocationInput | null;
  partyExemptions?: ParsedTaxExemption[];
  exemptionOrgPolicy?: TaxExemptionOrgPolicy;
  statePackProfiles?: Record<string, StatePackProfile>;
  useIndustryHvacMapping?: boolean;
};
