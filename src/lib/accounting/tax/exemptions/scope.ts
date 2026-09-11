/** Jurisdiction scope match — supports exact key, wildcard, and parent jurisdiction prefix. */
export function jurisdictionScopeMatches(
  scope: string[],
  transactionJurisdictionKey: string,
): boolean {
  if (scope.length === 0) return false;
  if (scope.includes("*")) return true;
  for (const entry of scope) {
    if (entry === transactionJurisdictionKey) return true;
    if (transactionJurisdictionKey.startsWith(`${entry}-`)) return true;
    if (entry.startsWith(`${transactionJurisdictionKey}-`)) return true;
  }
  return false;
}

/** Category scope match — supports exact category or wildcard. */
export function categoryScopeMatches(scope: string[], taxCategoryKey: string): boolean {
  if (scope.length === 0) return false;
  if (scope.includes("*")) return true;
  return scope.includes(taxCategoryKey);
}
