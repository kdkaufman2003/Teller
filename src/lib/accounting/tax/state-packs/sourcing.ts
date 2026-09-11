import type { TaxLocationInput } from "../types";
import type { TaxLocationSources, ResolvedTaxLocation } from "../calculation/location";
import { TaxReviewReason } from "../calculation/reason-codes";
import type { StatePackSourcingModel } from "./types";

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

/** State-pack-aware location resolution — does not replace legal research; encodes configured sourcing model. */
export function resolveTaxLocationForStatePack(
  sources: TaxLocationSources,
  sourcingModel: StatePackSourcingModel,
): ResolvedTaxLocation {
  const originOrder: Array<[TaxLocationInput | null | undefined, string]> = [
    [sources.sellerLocation, "seller"],
    [sources.transactionLocation, "transaction"],
    [sources.serviceLocation, "service"],
    [sources.shipToLocation, "ship_to"],
    [sources.customerLocation, "customer"],
  ];

  const destinationOrder: Array<[TaxLocationInput | null | undefined, string]> = [
    [sources.shipToLocation, "ship_to"],
    [sources.serviceLocation, "service"],
    [sources.customerLocation, "customer"],
    [sources.transactionLocation, "transaction"],
    [sources.sellerLocation, "seller"],
  ];

  const ordered = sourcingModel === "origin_seller" ? originOrder : destinationOrder;

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

export function inferStateFromJurisdictionKey(jurisdictionKey: string | null): string | null {
  if (!jurisdictionKey) return null;
  const parts = jurisdictionKey.split("-");
  if (parts.length >= 2 && parts[0] === "US") return parts[1]!.toUpperCase();
  return null;
}

export function resolveSourcingModelForLocation(
  jurisdictionKey: string | null,
  profiles: Record<string, { sourcingModel: StatePackSourcingModel }>,
  fallback: StatePackSourcingModel = "destination",
): StatePackSourcingModel {
  const state = inferStateFromJurisdictionKey(jurisdictionKey);
  if (state && profiles[state]) return profiles[state]!.sourcingModel;
  return fallback;
}
