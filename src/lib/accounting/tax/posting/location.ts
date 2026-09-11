import type { TaxLocationInput } from "../types";

type OrgLocationSource = {
  country?: string | null;
  state?: string | null;
  city?: string | null;
  county?: string | null;
  postal_code?: string | null;
};

export function taxLocationFromOrg(org: OrgLocationSource): TaxLocationInput {
  return {
    country: org.country || "US",
    state: org.state || undefined,
    city: org.city || undefined,
    county: org.county || undefined,
    postalCode: org.postal_code || undefined,
  };
}
