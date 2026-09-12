export const LEGAL_ENTITY_TYPES = [
  "llc",
  "corporation",
  "partnership",
  "sole_proprietorship",
  "other",
] as const;

export type LegalEntityType = (typeof LEGAL_ENTITY_TYPES)[number];

export type LegalEntityRow = {
  id: string;
  organization_id: string;
  name: string;
  legal_name: string;
  entity_code: string;
  entity_type: LegalEntityType;
  tax_identifier_last4: string;
  country_code: string;
  state_code: string;
  base_currency: string;
  is_default: boolean;
  is_active: boolean;
  consolidation_enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type LegalEntitySummary = {
  id: string;
  organizationId: string;
  name: string;
  legalName: string;
  entityCode: string;
  entityType: LegalEntityType;
  baseCurrency: string;
  isDefault: boolean;
  isActive: boolean;
  consolidationEnabled: boolean;
};

export type CreateLegalEntityInput = {
  organizationId: string;
  name: string;
  legalName?: string;
  entityCode: string;
  entityType?: LegalEntityType;
  countryCode?: string;
  stateCode?: string;
  baseCurrency?: string;
  isDefault?: boolean;
  actorId?: string | null;
};

export type UpdateLegalEntityInput = {
  organizationId: string;
  legalEntityId: string;
  name?: string;
  legalName?: string;
  entityType?: LegalEntityType;
  countryCode?: string;
  stateCode?: string;
  baseCurrency?: string;
  actorId?: string | null;
};
