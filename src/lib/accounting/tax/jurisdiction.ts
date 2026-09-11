import type { TaxJurisdictionNode, TaxJurisdictionType } from "./types";

const TYPE_RANK: Record<TaxJurisdictionType, number> = {
  country: 0,
  state: 1,
  county: 2,
  city: 3,
  district: 4,
};

/** Validates parent/child hierarchy (country → state → county → city → district). */
export function validateJurisdictionHierarchy(
  node: Pick<TaxJurisdictionNode, "jurisdictionType" | "parentJurisdictionKey">,
  parent?: Pick<TaxJurisdictionNode, "jurisdictionType" | "jurisdictionKey"> | null,
): { ok: true } | { ok: false; reason: string } {
  if (node.jurisdictionType === "country" && node.parentJurisdictionKey) {
    return { ok: false, reason: "Country jurisdictions cannot have a parent" };
  }
  if (node.jurisdictionType !== "country" && !node.parentJurisdictionKey) {
    return { ok: false, reason: `${node.jurisdictionType} requires a parent jurisdiction` };
  }
  if (parent && TYPE_RANK[parent.jurisdictionType] >= TYPE_RANK[node.jurisdictionType]) {
    return {
      ok: false,
      reason: `Parent type ${parent.jurisdictionType} must be above ${node.jurisdictionType}`,
    };
  }
  return { ok: true };
}

export function buildJurisdictionPath(
  node: TaxJurisdictionNode,
  byKey: Map<string, TaxJurisdictionNode>,
): TaxJurisdictionNode[] {
  const path: TaxJurisdictionNode[] = [node];
  let current = node;
  const seen = new Set<string>([node.jurisdictionKey]);
  while (current.parentJurisdictionKey) {
    const parent = byKey.get(current.parentJurisdictionKey);
    if (!parent || seen.has(parent.jurisdictionKey)) break;
    path.unshift(parent);
    seen.add(parent.jurisdictionKey);
    current = parent;
  }
  return path;
}

export function jurisdictionDisplayName(node: TaxJurisdictionNode): string {
  const parts = [node.city, node.county, node.state, node.country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : node.name;
}
