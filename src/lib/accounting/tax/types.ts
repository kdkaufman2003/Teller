/** Phase 15 sales & use tax accounting domain types. */

export type TaxJurisdictionType = "country" | "state" | "county" | "city" | "district";

export type TaxAuthorityAdminLevel = "state" | "county" | "city" | "district" | "combined";

export type TaxRegistrationStatus = "active" | "inactive" | "pending";

export type TaxFilingFrequency = "monthly" | "quarterly" | "annual" | "other";

export type TaxCategoryScope = "reference" | "organization";

export type TaxDeterminationStatus = "resolved" | "exempt" | "non_taxable" | "needs_review" | "override";

export type TaxTreatment = "taxable" | "non_taxable" | "exempt" | "needs_review";

export type TaxRoundingPolicy = "per_line" | "per_component" | "per_document";

export type TaxSetupStatus = "not_configured" | "needs_review" | "configured";

export type TaxTransactionType =
  | "sales_tax_collected"
  | "sales_tax_reversed"
  | "sales_tax_refunded"
  | "use_tax_accrued"
  | "tax_adjustment"
  | "authority_payment";

export type TaxSourceType =
  | "invoice"
  | "credit_memo"
  | "refund"
  | "bill"
  | "vendor_credit"
  | "manual_adjustment"
  | "authority_payment"
  | "other";

export type TaxRateComponentType = "state" | "county" | "city" | "district" | "other";

export type TaxRuleSourceKind = "organization_override" | "industry_profile" | "reference_rule_set";

export type TaxExemptionStatus = "active" | "inactive" | "pending" | "expired";

export type TaxLocationInput = {
  country?: string;
  state?: string;
  county?: string;
  city?: string;
  postalCode?: string;
  /** ship-to, service, seller, job/property — resolved by caller in later slices */
  locationKind?: "ship_to" | "service" | "seller" | "job" | "customer";
};

export type TaxJurisdictionNode = {
  jurisdictionKey: string;
  name: string;
  jurisdictionType: TaxJurisdictionType;
  country: string;
  state?: string | null;
  county?: string | null;
  city?: string | null;
  parentJurisdictionKey?: string | null;
};

export type TaxAuthorityRecord = {
  authorityKey: string;
  name: string;
  jurisdictionKey: string;
  adminLevel: TaxAuthorityAdminLevel;
};

export type TaxRegistrationRecord = {
  id: string;
  organizationId: string;
  authorityId?: string | null;
  jurisdictionKey?: string | null;
  registrationNumber?: string | null;
  filingFrequency: TaxFilingFrequency;
  status: TaxRegistrationStatus;
  effectiveFrom: string;
  effectiveTo?: string | null;
};

export type TaxRateComponentRecord = {
  componentType: TaxRateComponentType;
  jurisdictionKey: string;
  authorityId?: string | null;
  ratePercent: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
};

export type TaxCategoryRecord = {
  categoryKey: string;
  name: string;
  scope: TaxCategoryScope;
  organizationId?: string | null;
};

export type TaxabilityRuleRecord = {
  id: string;
  organizationId: string;
  jurisdictionKey: string;
  taxCategoryKey: string;
  treatment: TaxTreatment;
  priority: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  sourceKind: TaxRuleSourceKind;
  ruleSetSlug?: string | null;
};

export type TaxExemptionRecord = {
  id: string;
  organizationId: string;
  partyId?: string | null;
  certificateNumber?: string | null;
  certificateOnFile: boolean;
  jurisdictionScope: string[];
  categoryScope: string[];
  status: TaxExemptionStatus;
  effectiveFrom: string;
  effectiveTo?: string | null;
};

export type TaxSettingsRecord = {
  organizationId: string;
  salesTaxPayableAccountId?: string | null;
  useTaxExpenseAccountId?: string | null;
  roundingPolicy: TaxRoundingPolicy;
  setupStatus: TaxSetupStatus;
  taxInclusiveSupported: boolean;
};

export type TaxTransactionRecord = {
  id: string;
  organizationId: string;
  transactionType: TaxTransactionType;
  sourceType: TaxSourceType;
  sourceId?: string | null;
  documentId?: string | null;
  lineId?: string | null;
  determinationStatus: TaxDeterminationStatus;
  transactionDate: string;
  taxableBasis: number;
  taxAmount: number;
  primaryJurisdictionKey?: string | null;
  isPosted: boolean;
};

export type TaxDeterminationSnapshotRecord = {
  id: string;
  organizationId: string;
  documentId?: string | null;
  lineId?: string | null;
  transactionDate: string;
  taxCategoryKey?: string | null;
  jurisdictionKey?: string | null;
  determinationStatus: TaxDeterminationStatus;
  taxableBasis: number;
  taxAmount: number;
  ratePercent?: number | null;
  ruleSetSlug?: string | null;
  ruleKey?: string | null;
  components: TaxRateComponentRecord[];
  precedenceTrace: Record<string, unknown>;
};
