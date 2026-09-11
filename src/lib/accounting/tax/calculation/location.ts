import { TaxReviewReason } from "./reason-codes";
import type { TaxLocationInput } from "../types";

export type TaxLocationSources = {
  transactionLocation?: TaxLocationInput | null;
  serviceLocation?: TaxLocationInput | null;
  shipToLocation?: TaxLocationInput | null;
  customerLocation?: TaxLocationInput | null;
  sellerLocation?: TaxLocationInput | null;
};

export type ResolvedTaxLocation = {
  location: TaxLocationInput | null;
  source: string | null;
  jurisdictionKey: string | null;
  reasonCodes: string[];
};

function hasState(loc?: TaxLocationInput | null): boolean {
  return Boolean(loc?.state?.trim());
}

function buildJurisdictionKey(loc: TaxLocationInput): string | null {
  const country = (loc.country ?? "US").trim().toUpperCase();
  const state = loc.state?.trim().toUpperCase();
  if (!state) return null;
  const county = loc.county?.trim();
  const city = loc.city?.trim();
  if (city && county) return `${country}-${state}-${county}-${city}`.replace(/\s+/g, "_");
  if (county) return `${country}-${state}-${county}`.replace(/\s+/g, "_");
  return `${country}-${state}`;
}

/** Deterministic location precedence — input resolution only, not legal sourcing. */
export function resolveTaxLocation(sources: TaxLocationSources): ResolvedTaxLocation {
  const ordered: Array<[TaxLocationInput | null | undefined, string]> = [
    [sources.transactionLocation, "transaction"],
    [sources.serviceLocation, "service"],
    [sources.shipToLocation, "ship_to"],
    [sources.customerLocation, "customer"],
    [sources.sellerLocation, "seller"],
  ];

  for (const [loc, source] of ordered) {
    if (hasState(loc)) {
      return {
        location: loc!,
        source,
        jurisdictionKey: buildJurisdictionKey(loc!),
        reasonCodes: [],
      };
    }
  }

  return {
    location: null,
    source: null,
    jurisdictionKey: null,
    reasonCodes: [TaxReviewReason.MISSING_TAX_LOCATION],
  };
}
