import { roundMoney } from "@/lib/accounting/payment-fees";
import type { TaxRateComponentRecord, TaxRoundingPolicy } from "./types";

export type EffectiveDated = {
  effectiveFrom: string;
  effectiveTo?: string | null;
};

export function isEffectiveOn(record: EffectiveDated, asOf: string): boolean {
  if (record.effectiveFrom > asOf) return false;
  if (record.effectiveTo && record.effectiveTo < asOf) return false;
  return true;
}

export function validateRatePercent(ratePercent: number): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(ratePercent) || ratePercent < 0) {
    return { ok: false, reason: "Tax rate must be a non-negative number" };
  }
  if (ratePercent > 100) {
    return { ok: false, reason: "Tax rate cannot exceed 100%" };
  }
  return { ok: true };
}

export function validateEffectiveRange(
  effectiveFrom: string,
  effectiveTo?: string | null,
): { ok: true } | { ok: false; reason: string } {
  if (effectiveTo && effectiveTo < effectiveFrom) {
    return { ok: false, reason: "effective_to must be on or after effective_from" };
  }
  return { ok: true };
}

export function combinedRatePercent(components: Pick<TaxRateComponentRecord, "ratePercent">[]): number {
  const total = components.reduce((sum, c) => sum + c.ratePercent, 0);
  return roundMoney(total * 10000) / 10000;
}

export function findOverlappingRateComponents(
  components: TaxRateComponentRecord[],
  asOf: string,
): TaxRateComponentRecord[] | null {
  const active = components.filter((c) => isEffectiveOn(c, asOf));
  const byType = new Map<string, TaxRateComponentRecord[]>();
  for (const component of active) {
    const key = `${component.componentType}:${component.jurisdictionKey}`;
    const list = byType.get(key) ?? [];
    list.push(component);
    byType.set(key, list);
  }
  for (const list of byType.values()) {
    if (list.length > 1) return list;
  }
  return null;
}

export function applyRoundingPolicy(
  amounts: number[],
  policy: TaxRoundingPolicy,
): number {
  if (amounts.length === 0) return 0;
  if (policy === "per_line" || policy === "per_component") {
    return amounts.reduce((sum, amount) => sum + roundMoney(amount), 0);
  }
  const raw = amounts.reduce((sum, amount) => sum + amount, 0);
  return roundMoney(raw);
}

export function taxAmountFromBasis(basis: number, ratePercent: number): number {
  if (basis <= 0 || ratePercent <= 0) return 0;
  return roundMoney((basis * ratePercent) / 100);
}
