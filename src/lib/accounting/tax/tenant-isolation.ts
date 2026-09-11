/** Cross-org rejection helpers for tax domain records. */

export function assertSameOrganization(
  expectedOrgId: string,
  actualOrgId: string | null | undefined,
  label: string,
): void {
  if (!actualOrgId || actualOrgId !== expectedOrgId) {
    throw new Error(`${label} must belong to organization ${expectedOrgId}`);
  }
}

export function rejectCrossOrgReference(
  organizationId: string,
  relatedOrganizationId: string | null | undefined,
): boolean {
  return !relatedOrganizationId || relatedOrganizationId !== organizationId;
}
