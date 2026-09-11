import type { TaxExemptionRecord, TaxExemptionStatus } from "../types";

/** Generalized certificate types — not HVAC-specific. */
export const TAX_EXEMPTION_CERTIFICATE_TYPES = [
  "resale",
  "government",
  "nonprofit",
  "manufacturing",
  "agricultural",
  "direct_pay",
  "other",
] as const;

export type TaxExemptionCertificateType = (typeof TAX_EXEMPTION_CERTIFICATE_TYPES)[number];

/** App-layer lifecycle (maps to DB status + metadata). */
export type TaxExemptionLifecycleStatus =
  | "draft"
  | "active"
  | "expired"
  | "revoked"
  | "rejected"
  | "needs_review";

export type TaxExemptionReviewStatus = "draft" | "needs_review" | "approved" | "rejected";

export type TaxExemptionMetadata = {
  certificateType?: TaxExemptionCertificateType | string;
  issuingJurisdictionKey?: string | null;
  reviewStatus?: TaxExemptionReviewStatus;
  notes?: string | null;
  attachmentStoragePath?: string | null;
  attachmentFileName?: string | null;
  revokedEffectiveFrom?: string | null;
  rejectedAt?: string | null;
  rejectionReason?: string | null;
  source?: string | null;
  duplicateWarning?: boolean;
};

export type ParsedTaxExemption = TaxExemptionRecord & {
  metadata: TaxExemptionMetadata;
  certificateType?: TaxExemptionCertificateType | string | null;
  issuingJurisdictionKey?: string | null;
  reviewStatus?: TaxExemptionReviewStatus;
  notes?: string | null;
  lifecycleStatus: TaxExemptionLifecycleStatus;
  createdBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type TaxExemptionOrgPolicy = {
  requireCertificateNumber?: boolean;
  requireCertificateOnFile?: boolean;
};

export type ExemptionResolutionStatus = "valid" | "none" | "needs_review" | "ambiguous";

export type ExemptionResolutionResult = {
  status: ExemptionResolutionStatus;
  exemption: ParsedTaxExemption | null;
  reasonCodes: string[];
  warnings: string[];
};

export type TaxExemptionRow = {
  id: string;
  organization_id: string;
  party_id: string | null;
  certificate_number: string | null;
  certificate_on_file: boolean;
  jurisdiction_scope: unknown;
  category_scope: unknown;
  status: TaxExemptionStatus;
  effective_from: string;
  effective_to: string | null;
  metadata: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateTaxExemptionInput = {
  partyId: string;
  certificateNumber?: string | null;
  certificateType?: TaxExemptionCertificateType | string;
  issuingJurisdictionKey?: string | null;
  jurisdictionScope: string[];
  categoryScope: string[];
  effectiveFrom: string;
  effectiveTo?: string | null;
  certificateOnFile?: boolean;
  notes?: string | null;
  attachmentStoragePath?: string | null;
  attachmentFileName?: string | null;
  source?: string | null;
};

export type UpdateTaxExemptionInput = Partial<
  Omit<CreateTaxExemptionInput, "partyId" | "effectiveFrom">
> & {
  effectiveFrom?: string;
};

export const EXEMPTION_EXPIRY_WARNING_DAYS = {
  soon60: 60,
  soon30: 30,
} as const;

export type ExemptionExpiryWarning = "expired" | "expires_within_30_days" | "expires_within_60_days" | null;
