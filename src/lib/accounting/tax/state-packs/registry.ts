import moPack from "../../../../../tax-rules/state-packs/MO-2026.1.json";
import ksPack from "../../../../../tax-rules/state-packs/KS-2026.1.json";
import type { TaxTreatment } from "../types";
import type { StatePackProfile, StateTaxPack } from "./types";

const PACKS: StateTaxPack[] = [moPack as StateTaxPack, ksPack as StateTaxPack];

const BY_ID = new Map(PACKS.map((pack) => [pack.packId, pack]));
const BY_STATE = new Map(PACKS.map((pack) => [pack.state.toUpperCase(), pack]));

export function listStateTaxPacks(): StateTaxPack[] {
  return [...PACKS];
}

export function getStateTaxPack(packId: string): StateTaxPack | null {
  return BY_ID.get(packId) ?? null;
}

export function getStateTaxPackForState(state: string): StateTaxPack | null {
  return BY_STATE.get(state.trim().toUpperCase()) ?? null;
}

export function toStatePackProfile(pack: StateTaxPack): StatePackProfile {
  return {
    packId: pack.packId,
    version: pack.version,
    state: pack.state,
    slug: pack.slug,
    sourcingModel: pack.sourcingModel,
    unknownLocalRateHandling: pack.unknownLocalRateHandling,
    sourceReviewedAt: pack.sourceReviewedAt,
  };
}

export function buildReferenceCategoryTreatments(pack: StateTaxPack): Record<string, TaxTreatment> {
  const treatments: Record<string, TaxTreatment> = {};
  for (const rule of pack.taxabilityRules) {
    treatments[`${rule.jurisdictionKey}:${rule.taxCategoryKey}`] = rule.treatment;
  }
  return treatments;
}
