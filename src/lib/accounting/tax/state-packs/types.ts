import type { TaxAuthorityAdminLevel, TaxFilingFrequency, TaxTreatment } from "../types";

export type StatePackSourcingModel = "origin_seller" | "destination";

export type StatePackSourceReference = {
  agency: string;
  document: string;
  url?: string;
  retrievedAt: string;
  notes?: string;
};

export type StatePackAuthority = {
  authorityKey: string;
  name: string;
  jurisdictionKey: string;
  adminLevel: TaxAuthorityAdminLevel;
};

export type StatePackJurisdiction = {
  jurisdictionKey: string;
  name: string;
  jurisdictionType: "country" | "state" | "county" | "city" | "district";
  country?: string;
  state?: string;
  county?: string;
  city?: string;
  parentJurisdictionKey?: string | null;
};

export type StatePackRateComponent = {
  jurisdictionKey: string;
  componentType: "state" | "county" | "city" | "district" | "other";
  ratePercent: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  authorityKey?: string | null;
  sourceCitation: string;
};

export type StatePackTaxabilityRule = {
  jurisdictionKey: string;
  taxCategoryKey: string;
  treatment: TaxTreatment;
  priority: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  sourceCitation: string;
};

export type StateTaxPack = {
  packId: string;
  slug: string;
  name: string;
  state: string;
  version: string;
  status: "draft" | "reviewed" | "active" | "retired";
  effectiveFrom: string;
  effectiveTo?: string | null;
  sourceReviewedAt: string;
  sourceDocumentation: string;
  sourcingModel: StatePackSourcingModel;
  unknownLocalRateHandling: "needs_review";
  filingFrequencyOptions: TaxFilingFrequency[];
  sourceReferences: StatePackSourceReference[];
  authorities: StatePackAuthority[];
  jurisdictions: StatePackJurisdiction[];
  rateComponents: StatePackRateComponent[];
  taxabilityRules: StatePackTaxabilityRule[];
  exemptionTypes?: Array<{ certificateType: string; label: string; sourceCitation: string }>;
};

export type StatePackProfile = {
  packId: string;
  version: string;
  state: string;
  slug: string;
  sourcingModel: StatePackSourcingModel;
  unknownLocalRateHandling: "needs_review";
  sourceReviewedAt: string;
};
