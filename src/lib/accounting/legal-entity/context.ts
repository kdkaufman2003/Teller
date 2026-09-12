/**
 * Canonical accounting context for future posting services.
 * Phase 16A establishes the pattern; domain tables gain legal_entity_id in later slices.
 */
export type AccountingContext = {
  organizationId: string;
  legalEntityId: string;
};

export function accountingContext(
  organizationId: string,
  legalEntityId: string,
): AccountingContext {
  if (!organizationId?.trim()) throw new Error("organizationId is required");
  if (!legalEntityId?.trim()) throw new Error("legalEntityId is required");
  return { organizationId, legalEntityId };
}
