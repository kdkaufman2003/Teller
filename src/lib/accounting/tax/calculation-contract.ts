/** Legacy contract re-exports — canonical engine lives in ./calculation/ */
export {
  calculateTax,
  reconcileDocumentTotals,
  TAX_ENGINE_VERSION,
} from "./calculation/engine";
export type {
  TaxCalculationConfig,
  TaxCalculationInput,
  TaxCalculationLineInput,
  TaxCalculationLineResult,
  TaxCalculationResult,
} from "./calculation/types";
