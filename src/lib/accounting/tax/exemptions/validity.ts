import { isEffectiveOn } from "../rates";
import type { ParsedTaxExemption } from "./types";
import { EXEMPTION_EXPIRY_WARNING_DAYS, type ExemptionExpiryWarning } from "./types";

export function isExemptionDateValid(exemption: ParsedTaxExemption, transactionDate: string): boolean {
  if (transactionDate < exemption.effectiveFrom) return false;
  if (exemption.effectiveTo && transactionDate > exemption.effectiveTo) return false;
  if (!isEffectiveOn(exemption, transactionDate)) return false;
  const revokedFrom = exemption.metadata.revokedEffectiveFrom;
  if (revokedFrom && transactionDate >= revokedFrom) return false;
  return true;
}

export function expirationWarningLevel(
  exemption: ParsedTaxExemption,
  asOf: string,
): ExemptionExpiryWarning {
  if (!exemption.effectiveTo) return null;
  if (exemption.effectiveTo < asOf) return "expired";
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const expiresMs = Date.parse(`${exemption.effectiveTo}T00:00:00Z`);
  const daysRemaining = Math.floor((expiresMs - asOfMs) / (24 * 60 * 60 * 1000));
  if (daysRemaining <= EXEMPTION_EXPIRY_WARNING_DAYS.soon30) return "expires_within_30_days";
  if (daysRemaining <= EXEMPTION_EXPIRY_WARNING_DAYS.soon60) return "expires_within_60_days";
  return null;
}
