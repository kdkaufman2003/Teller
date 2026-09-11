import { splitTaxInclusive } from "../inclusive";
import { resolveLineCategory } from "./category";
import { resolveTaxLocation, type ResolvedTaxLocation, type TaxLocationSources } from "./location";
import { fromCents, resolveLineAmount, taxFromBasisCents, toCents } from "./money";
import { resolveRateComponents } from "./rate-resolution";
import {
  inferStateFromJurisdictionKey,
  resolveRateComponentsWithLocalPolicy,
  resolveTaxLocationForStatePack,
} from "../state-packs";
import type { StatePackProfile } from "../state-packs/types";
import { resolveCustomerExemption, toTaxabilityExemption } from "../exemptions/resolver";
import { resolveLineTaxability } from "./rules";
import { TaxReviewReason } from "./reason-codes";
import type {
  TaxCalculationConfig,
  TaxCalculationInput,
  TaxCalculationLineResult,
  TaxCalculationResult,
  TaxComponentResult,
  TAX_ENGINE_VERSION,
} from "./types";
import type { TaxDeterminationStatus, TaxTreatment } from "../types";

export { TAX_ENGINE_VERSION } from "./types";

function normalizeState(state?: string | null): string | null {
  const trimmed = state?.trim().toUpperCase();
  return trimmed || null;
}

function resolveGoverningState(
  sources: TaxLocationSources,
  config: TaxCalculationConfig,
): { governingState: string | null; crossBorder: boolean } {
  const transactionState = normalizeState(sources.transactionLocation?.state);
  const serviceState = normalizeState(sources.serviceLocation?.state);
  const customerState = normalizeState(sources.customerLocation?.state);
  const shipState = normalizeState(sources.shipToLocation?.state);
  const explicitSellerState = normalizeState(sources.sellerLocation?.state);
  const orgSellerState = normalizeState(config.sellerLocation?.state);
  const sellerState = explicitSellerState ?? orgSellerState;

  const crossBorder = Boolean(sellerState && shipState && sellerState !== shipState);
  if (crossBorder) {
    return { governingState: shipState, crossBorder: true };
  }

  // Prefer transaction-facing locations over implicit org seller when selecting a state pack.
  const governingState =
    shipState ??
    transactionState ??
    serviceState ??
    customerState ??
    explicitSellerState ??
    orgSellerState;

  return { governingState, crossBorder: false };
}

function resolveDocumentLocation(
  sources: TaxLocationSources,
  config: TaxCalculationConfig,
): ResolvedTaxLocation & { crossBorder: boolean; statePackVersion?: string | null } {
  const { governingState, crossBorder } = resolveGoverningState(sources, config);
  const profile: StatePackProfile | undefined = governingState
    ? config.statePackProfiles?.[governingState]
    : undefined;

  if (profile) {
    const resolved = resolveTaxLocationForStatePack(sources, profile.sourcingModel);
    return {
      ...resolved,
      crossBorder,
      statePackVersion: profile.version,
    };
  }

  return { ...resolveTaxLocation(sources), crossBorder, statePackVersion: null };
}

function allocateInclusiveComponentTax(
  totalTaxCents: number,
  components: Array<{ componentType: string; jurisdictionKey: string; ratePercent: number; rateId?: string | null; authorityId?: string | null; effectiveFrom: string; effectiveTo?: string | null }>,
  combinedRate: number,
): TaxComponentResult[] {
  if (components.length === 0 || combinedRate <= 0) return [];
  let allocated = 0;
  const results: TaxComponentResult[] = [];
  for (let i = 0; i < components.length; i++) {
    const component = components[i]!;
    const isLast = i === components.length - 1;
    const share = isLast
      ? totalTaxCents - allocated
      : Math.round((totalTaxCents * component.ratePercent) / combinedRate);
    allocated += share;
    results.push({
      ...component,
      componentType: component.componentType as TaxComponentResult["componentType"],
      taxableBasis: 0,
      taxAmount: fromCents(share),
    });
  }
  return results;
}

function computeLineTax(
  basisCents: number,
  rateResolution: ReturnType<typeof resolveRateComponents>,
  taxInclusive: boolean,
  roundingPolicy: TaxCalculationConfig["roundingPolicy"],
): { taxCents: number; components: TaxComponentResult[]; combinedRate: number | null } {
  if (!rateResolution.ok || basisCents === 0) {
    return { taxCents: 0, components: [], combinedRate: rateResolution.ok ? rateResolution.combinedRatePercent : null };
  }

  const combinedRate = rateResolution.combinedRatePercent;
  if (combinedRate <= 0) {
    return { taxCents: 0, components: rateResolution.components.map((c) => ({ ...c, taxableBasis: fromCents(basisCents), taxAmount: 0 })), combinedRate: 0 };
  }

  const basis = fromCents(basisCents);

  if (taxInclusive) {
    const sign = basisCents < 0 ? -1 : 1;
    const split = splitTaxInclusive(Math.abs(basis), combinedRate);
    const absTaxCents = toCents(split.taxAmount);
    const components = allocateInclusiveComponentTax(absTaxCents, rateResolution.components, combinedRate);
    const taxableBasis = fromCents(toCents(split.basis)) * sign;
    for (const component of components) {
      component.taxableBasis = taxableBasis;
      component.taxAmount = component.taxAmount * sign;
    }
    return { taxCents: absTaxCents * sign, components, combinedRate };
  }

  const componentTaxCents: number[] = [];
  const components: TaxComponentResult[] = rateResolution.components.map((component) => {
    const rawCents = taxFromBasisCents(Math.abs(basisCents), component.ratePercent) * (basisCents < 0 ? -1 : 1);
    componentTaxCents.push(fromCents(Math.abs(rawCents)));
    return {
      ...component,
      taxableBasis: basis,
      taxAmount: fromCents(rawCents),
    };
  });

  const taxCents =
    roundingPolicy === "per_component"
      ? componentTaxCents.reduce((sum, c) => sum + toCents(fromCents(c)), 0) * (basisCents < 0 ? -1 : 1)
      : taxFromBasisCents(Math.abs(basisCents), combinedRate) * (basisCents < 0 ? -1 : 1);

  if (roundingPolicy === "per_component") {
    let allocated = 0;
    for (let i = 0; i < components.length; i++) {
      const isLast = i === components.length - 1;
      const cents = isLast ? Math.abs(taxCents) - allocated : toCents(Math.abs(components[i]!.taxAmount));
      allocated += cents;
      components[i]!.taxAmount = fromCents(cents) * (basisCents < 0 ? -1 : 1);
    }
  }

  return { taxCents, components, combinedRate };
}

function classifyBasis(
  lineAmountCents: number,
  treatment: TaxTreatment,
): { taxable: number; nonTaxable: number; exempt: number } {
  const amount = fromCents(lineAmountCents);
  if (treatment === "taxable") return { taxable: amount, nonTaxable: 0, exempt: 0 };
  if (treatment === "exempt") return { taxable: 0, nonTaxable: 0, exempt: amount };
  if (treatment === "non_taxable") return { taxable: 0, nonTaxable: amount, exempt: 0 };
  return { taxable: 0, nonTaxable: amount, exempt: 0 };
}

/** Pure deterministic tax calculation — no DB or journal side effects. */
export function calculateTax(input: TaxCalculationInput, config: TaxCalculationConfig): TaxCalculationResult {
  const warnings: string[] = [];
  const reasonCodes = new Set<string>();
  const lineResults: TaxCalculationLineResult[] = [];

  const locationSources: TaxLocationSources = {
    transactionLocation: input.location.transactionLocation,
    serviceLocation: input.location.serviceLocation,
    shipToLocation: input.location.shipToLocation,
    customerLocation: input.location.customerLocation,
    sellerLocation: input.location.sellerLocation ?? config.sellerLocation,
  };
  const documentLocation = resolveDocumentLocation(locationSources, config);

  for (const line of input.lines) {
    const lineAmountCents = toCents(resolveLineAmount(line));
    const lineLocation = line.locationOverride
      ? resolveDocumentLocation(
          { transactionLocation: line.locationOverride, sellerLocation: config.sellerLocation },
          config,
        )
      : documentLocation;

    for (const code of lineLocation.reasonCodes) reasonCodes.add(code);

    const category = resolveLineCategory({
      explicitCategory: line.taxCategory,
      itemType: line.itemType,
      useIndustryHvacMapping: config.useIndustryHvacMapping,
    });
    for (const code of category.reasonCodes) reasonCodes.add(code);

    const jurisdictionKey = lineLocation.jurisdictionKey;
    const taxCategoryKey = category.categoryKey ?? "other";

    let customerExemption = input.customer?.exemption ?? null;
    let matchedExemption: ReturnType<typeof resolveCustomerExemption>["exemption"] = null;
    const exemptionReasonCodes: TaxCalculationLineResult["reasonCodes"] = [];
    let exemptionBlocksTaxability = false;

    if (
      !customerExemption &&
      !line.explicitTaxabilityOverride &&
      !input.explicitDocumentOverride &&
      input.customer?.partyId &&
      config.partyExemptions?.length &&
      jurisdictionKey &&
      category.categoryKey
    ) {
      const resolution = resolveCustomerExemption({
        exemptions: config.partyExemptions,
        transactionDate: input.transactionDate,
        jurisdictionKey,
        taxCategoryKey,
        orgPolicy: config.exemptionOrgPolicy,
      });
      matchedExemption = resolution.exemption;
      if (resolution.status === "valid" && resolution.exemption) {
        customerExemption = toTaxabilityExemption(resolution.exemption);
      } else if (resolution.status === "ambiguous" || resolution.status === "needs_review") {
        exemptionBlocksTaxability = true;
        for (const code of resolution.reasonCodes) {
          exemptionReasonCodes.push(code as TaxCalculationLineResult["reasonCodes"][number]);
          reasonCodes.add(code as TaxCalculationResult["reasonCodes"][number]);
        }
      }
    }

    const taxability = resolveLineTaxability({
      transactionDate: input.transactionDate,
      jurisdictionKey: jurisdictionKey ?? "unknown",
      taxCategoryKey,
      lineExplicitTreatment: line.explicitTaxabilityOverride ?? input.explicitDocumentOverride ?? null,
      customerExemption,
      organizationRules: config.taxabilityRules,
      industryDefaultTreatment: config.industryCategoryTreatments?.[taxCategoryKey] ?? null,
      referenceRuleTreatment: config.referenceCategoryTreatments?.[`${jurisdictionKey}:${taxCategoryKey}`] ?? null,
    });

    for (const code of taxability.reasonCodes) reasonCodes.add(code);

    let lineStatus: TaxDeterminationStatus = taxability.status;
    const lineReasonCodes = [...taxability.reasonCodes, ...exemptionReasonCodes];

    if (exemptionBlocksTaxability) {
      lineStatus = "needs_review";
    }

    if (!jurisdictionKey) {
      lineStatus = "needs_review";
      if (!lineReasonCodes.includes(TaxReviewReason.MISSING_TAX_LOCATION)) {
        lineReasonCodes.push(TaxReviewReason.MISSING_TAX_LOCATION);
      }
    }

    if (!category.categoryKey) {
      lineStatus = "needs_review";
      if (!lineReasonCodes.includes(TaxReviewReason.MISSING_TAX_CATEGORY)) {
        lineReasonCodes.push(TaxReviewReason.MISSING_TAX_CATEGORY);
      }
    }

    let classification = classifyBasis(lineAmountCents, taxability.treatment);
    let components: TaxComponentResult[] = [];
    let taxCents = 0;
    let combinedRate: number | null = null;

    if (category.reasonCodes.includes(TaxReviewReason.FACT_DEPENDENT_CLASSIFICATION)) {
      lineStatus = "needs_review";
    }

    if (taxability.treatment === "taxable" && lineStatus !== "needs_review" && jurisdictionKey) {
      const state = inferStateFromJurisdictionKey(jurisdictionKey);
      const profile = state ? config.statePackProfiles?.[state] : undefined;
      const rateResolution = profile
        ? resolveRateComponentsWithLocalPolicy(
            config.rateComponents,
            jurisdictionKey,
            input.transactionDate,
            profile.unknownLocalRateHandling,
          )
        : resolveRateComponents(config.rateComponents, jurisdictionKey, input.transactionDate);
      if (!rateResolution.ok) {
        lineStatus = "needs_review";
        for (const code of rateResolution.reasonCodes) {
          lineReasonCodes.push(code);
          reasonCodes.add(code);
        }
        warnings.push(...rateResolution.reasonCodes);
      } else {
        const taxInclusive = line.taxInclusive ?? input.mode === "inclusive";
        const computed = computeLineTax(lineAmountCents, rateResolution, taxInclusive, config.roundingPolicy);
        taxCents = computed.taxCents;
        if (taxInclusive && computed.combinedRate && computed.combinedRate > 0) {
          const sign = lineAmountCents < 0 ? -1 : 1;
          const preTaxBasis = fromCents(toCents(splitTaxInclusive(Math.abs(fromCents(lineAmountCents)), computed.combinedRate).basis)) * sign;
          classification = { taxable: preTaxBasis, nonTaxable: 0, exempt: 0 };
        }
        components = computed.components.map((c) => ({
          ...c,
          taxableBasis: classification.taxable,
        }));
        combinedRate = computed.combinedRate;
        if (combinedRate === 0 && taxability.zeroRateTaxable) {
          lineStatus = "resolved";
        }
      }
    }

    lineResults.push({
      lineId: line.lineId,
      lineKey: line.lineKey,
      taxCategoryKey: category.categoryKey,
      determinationStatus: lineStatus,
      treatment: taxability.treatment,
      taxableBasis: classification.taxable,
      nonTaxableBasis: classification.nonTaxable,
      exemptBasis: classification.exempt,
      taxAmount: fromCents(taxCents),
      jurisdictionKey,
      combinedRatePercent: combinedRate,
      zeroRateTaxable: taxability.zeroRateTaxable && combinedRate === 0,
      components,
      warnings: lineReasonCodes,
      reasonCodes: lineReasonCodes as TaxCalculationLineResult["reasonCodes"],
      precedenceSource: taxability.source,
      trace: {
        ...taxability.trace,
        locationSource: lineLocation.source,
        categorySource: category.source,
        statePackVersion: documentLocation.statePackVersion,
        crossBorder: documentLocation.crossBorder,
        exemptionId: matchedExemption?.id ?? customerExemption?.id ?? null,
        exemptionCertificateType: matchedExemption?.certificateType ?? null,
        exemptionEffectiveFrom: matchedExemption?.effectiveFrom ?? null,
        exemptionEffectiveTo: matchedExemption?.effectiveTo ?? null,
      },
      exemptionId: matchedExemption?.id ?? customerExemption?.id ?? null,
      exemptionCertificateType: matchedExemption?.certificateType ?? null,
      exemptionJurisdictionScope: matchedExemption?.jurisdictionScope,
      exemptionCategoryScope: matchedExemption?.categoryScope,
    });
  }

  const needsReviewLineCount = lineResults.filter((l) => l.determinationStatus === "needs_review").length;
  const resolvedLineCount = lineResults.length - needsReviewLineCount;
  const aggregateStatus: TaxDeterminationStatus = needsReviewLineCount > 0 ? "needs_review" : "resolved";

  const lineTaxCents = lineResults.map((l) => toCents(l.taxAmount));
  const taxTotal =
    config.roundingPolicy === "per_document"
      ? fromCents(lineTaxCents.reduce((sum, c) => sum + c, 0))
      : fromCents(lineTaxCents.reduce((sum, c) => sum + c, 0));

  const jurisdictionMap = new Map<string, TaxComponentResult>();
  for (const line of lineResults) {
    for (const component of line.components) {
      const key = `${component.componentType}:${component.jurisdictionKey}`;
      const existing = jurisdictionMap.get(key);
      if (existing) {
        existing.taxAmount = fromCents(toCents(existing.taxAmount) + toCents(component.taxAmount));
        existing.taxableBasis = fromCents(toCents(existing.taxableBasis) + toCents(component.taxableBasis));
      } else {
        jurisdictionMap.set(key, { ...component });
      }
    }
  }

  return {
    status: aggregateStatus,
    taxableSubtotal: fromCents(lineResults.reduce((sum, l) => sum + toCents(l.taxableBasis), 0)),
    nonTaxableSubtotal: fromCents(lineResults.reduce((sum, l) => sum + toCents(l.nonTaxableBasis), 0)),
    exemptSubtotal: fromCents(lineResults.reduce((sum, l) => sum + toCents(l.exemptBasis), 0)),
    taxTotal,
    lineResults,
    jurisdictionComponents: [...jurisdictionMap.values()],
    warnings: [...new Set([...warnings, ...lineResults.flatMap((l) => l.warnings)])],
    reasonCodes: [...reasonCodes] as TaxCalculationResult["reasonCodes"],
    determinationMetadata: {
      engineVersion: "teller_tax_engine_v1" as typeof TAX_ENGINE_VERSION,
      resolvedLineCount,
      needsReviewLineCount,
      roundingPolicy: config.roundingPolicy,
      locationSource: documentLocation.source,
      primaryJurisdictionKey: documentLocation.jurisdictionKey,
    },
  };
}

export function reconcileDocumentTotals(
  documentSubtotal: number,
  result: TaxCalculationResult,
): { ok: boolean; lineDifferenceCents: number; taxDifferenceCents: number } {
  const classifiedCents =
    toCents(result.taxableSubtotal) + toCents(result.nonTaxableSubtotal) + toCents(result.exemptSubtotal);
  const lineDifferenceCents = Math.abs(toCents(documentSubtotal) - classifiedCents);
  const summedLineTaxCents = result.lineResults.reduce((sum, line) => sum + toCents(line.taxAmount), 0);
  const taxDifferenceCents = Math.abs(toCents(result.taxTotal) - summedLineTaxCents);
  return { ok: lineDifferenceCents === 0 && taxDifferenceCents === 0, lineDifferenceCents, taxDifferenceCents };
}
