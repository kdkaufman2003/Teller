export function buildConsolidationScopeKey(
  organizationId: string,
  legalEntityIds: string[],
): string {
  const sorted = [...legalEntityIds].sort();
  return `${organizationId}:${sorted.join(",")}`;
}

export function scopeKeyMatchesEntities(scopeKey: string, organizationId: string, legalEntityIds: string[]): boolean {
  return scopeKey === buildConsolidationScopeKey(organizationId, legalEntityIds);
}
