import { calculateTax } from "./calculation/engine";
import type { TaxCalculationConfig, TaxCalculationInput, TaxCalculationResult } from "./calculation/types";

/** Future external providers (Avalara, TaxJar, etc.) implement this interface. */
export type TaxDeterminationProvider = {
  id: string;
  determineTax(
    input: TaxCalculationInput,
    config: TaxCalculationConfig,
  ): Promise<TaxCalculationResult> | TaxCalculationResult;
};

export const tellerNativeTaxProvider: TaxDeterminationProvider = {
  id: "teller_native",
  determineTax: calculateTax,
};
