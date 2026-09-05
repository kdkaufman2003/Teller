import type { TaxEvaluationContext, TaxLocation } from "./types";

type OrgLocationInput = {
  country?: string | null;
  state?: string | null;
  city?: string | null;
  postal_code?: string | null;
  address_line1?: string | null;
};

export function orgRecordToTaxLocation(org: OrgLocationInput): TaxLocation {
  return {
    country: org.country || "US",
    state: org.state || undefined,
    city: org.city || undefined,
    postalCode: org.postal_code || undefined,
  };
}

export function buildTaxContextFromOrg(org: OrgLocationInput): TaxEvaluationContext["businessLocation"] {
  const location = orgRecordToTaxLocation(org);
  return {
    country: location.country ?? "US",
    state: location.state ?? "",
    county: "",
    city: location.city ?? "",
    postalCode: location.postalCode ?? "",
  };
}
