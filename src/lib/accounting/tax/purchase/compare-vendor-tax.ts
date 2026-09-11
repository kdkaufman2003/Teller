import { roundMoney } from "../../payment-fees";
import type { TaxCalculationLineResult } from "../calculation/types";
import { classifyPurchaseLine } from "./classify-line";
import type {
  PurchaseLineClassification,
  PurchaseTaxComparisonResult,
  PurchaseTaxLineComparison,
  PurchaseTaxLineStatus,
  PurchaseTaxPostingInput,
} from "./types";

export type PurchaseLineClassificationInput = {
  lineKey: string;
  accountType?: string | null;
  costType?: string | null;
  itemType?: string | null;
};

function allocateVendorTaxProRata(
  lines: TaxCalculationLineResult[],
  vendorTaxTotal: number,
  vendorTaxByLine?: Record<string, number>,
): Map<string, number> {
  const map = new Map<string, number>();
  if (vendorTaxByLine && Object.keys(vendorTaxByLine).length > 0) {
    for (const line of lines) {
      const key = line.lineKey;
      map.set(key, roundMoney(vendorTaxByLine[key] ?? vendorTaxByLine[line.lineId ?? ""] ?? 0));
    }
    return map;
  }

  const taxableTotal = roundMoney(
    lines.reduce((sum, line) => sum + (line.treatment === "taxable" ? line.taxableBasis : 0), 0),
  );
  let assigned = 0;
  const taxableLines = lines.filter((line) => line.treatment === "taxable" && line.taxableBasis > 0);
  for (let i = 0; i < taxableLines.length; i += 1) {
    const line = taxableLines[i]!;
    let share: number;
    if (i === taxableLines.length - 1) {
      share = roundMoney(vendorTaxTotal - assigned);
    } else if (taxableTotal > 0) {
      share = roundMoney((line.taxableBasis / taxableTotal) * vendorTaxTotal);
      assigned = roundMoney(assigned + share);
    } else {
      share = 0;
    }
    map.set(line.lineKey, share);
  }
  for (const line of lines) {
    if (!map.has(line.lineKey)) map.set(line.lineKey, 0);
  }
  return map;
}

function lineStatus(
  line: TaxCalculationLineResult,
  requiredTax: number,
  vendorTax: number,
): PurchaseTaxLineStatus {
  if (line.determinationStatus === "needs_review") {
    return "needs_review";
  }
  if (line.treatment === "exempt") return "exempt";
  if (line.treatment === "non_taxable") return "non_taxable";
  if (requiredTax <= 0 && vendorTax <= 0) return "non_taxable";
  const useTaxDue = roundMoney(Math.max(requiredTax - vendorTax, 0));
  const overage = roundMoney(Math.max(vendorTax - requiredTax, 0));
  if (overage > 0.009) return "vendor_tax_overage";
  if (useTaxDue <= 0.009) return "fully_taxed";
  return "use_tax_due";
}

function classificationForLine(
  line: TaxCalculationLineResult,
  inputs?: PurchaseLineClassificationInput[],
): PurchaseLineClassification {
  const meta = inputs?.find((row) => row.lineKey === line.lineKey);
  return classifyPurchaseLine({
    accountType: meta?.accountType,
    costType: meta?.costType,
    itemType: meta?.itemType,
  });
}

/** Compare required purchase tax (15B engine) with explicit vendor-charged tax. */
export function comparePurchaseTax(
  input: PurchaseTaxPostingInput & { lineClassifications?: PurchaseLineClassificationInput[] },
): PurchaseTaxComparisonResult {
  const vendorTaxTotal = roundMoney(Math.max(input.vendorTaxCharged, 0));
  const vendorByLine = allocateVendorTaxProRata(
    input.calculation.lineResults,
    vendorTaxTotal,
    input.vendorTaxByLine,
  );

  const lineResults: PurchaseTaxLineComparison[] = input.calculation.lineResults.map((line) => {
    const requiredTax = roundMoney(line.taxAmount);
    const vendorTax = roundMoney(vendorByLine.get(line.lineKey) ?? 0);
    const useTaxDue = roundMoney(Math.max(requiredTax - vendorTax, 0));
    const vendorTaxOverage = roundMoney(Math.max(vendorTax - requiredTax, 0));
    const status = lineStatus(line, requiredTax, vendorTax);

    const components = line.components.map((component) => {
      const componentRequired = roundMoney(component.taxAmount);
      const ratio = requiredTax > 0 ? componentRequired / requiredTax : 0;
      const componentVendor = roundMoney(vendorTax * ratio);
      return {
        jurisdictionKey: component.jurisdictionKey,
        requiredTax: componentRequired,
        vendorTax: componentVendor,
        useTaxDue: roundMoney(Math.max(componentRequired - componentVendor, 0)),
      };
    });

    return {
      lineKey: line.lineKey,
      lineId: line.lineId,
      taxableBasis: line.taxableBasis,
      requiredTax,
      vendorTax,
      useTaxDue,
      vendorTaxOverage,
      status,
      classification: classificationForLine(line, input.lineClassifications),
      components,
    };
  });

  const requiredTaxTotal = roundMoney(lineResults.reduce((sum, line) => sum + line.requiredTax, 0));
  const useTaxDueTotal = roundMoney(lineResults.reduce((sum, line) => sum + line.useTaxDue, 0));
  const vendorTaxOverageTotal = roundMoney(
    lineResults.reduce((sum, line) => sum + line.vendorTaxOverage, 0),
  );

  const reasonCodes: string[] = [];
  const warnings: string[] = [];
  if (input.calculation.status === "needs_review") {
    reasonCodes.push("TAX_NEEDS_REVIEW");
  }
  if (lineResults.some((line) => line.status === "needs_review")) {
    reasonCodes.push("PURCHASE_TAX_NEEDS_REVIEW");
  }
  if (vendorTaxOverageTotal > 0.009) {
    warnings.push("VENDOR_TAX_OVERAGE");
  }

  let status: PurchaseTaxComparisonResult["status"] = "resolved";
  if (reasonCodes.length > 0) status = "needs_review";
  else if (vendorTaxOverageTotal > 0.009) status = "vendor_tax_overage";

  return {
    status,
    requiredTaxTotal,
    vendorTaxTotal,
    useTaxDueTotal,
    vendorTaxOverageTotal,
    lineResults,
    reasonCodes,
    warnings,
  };
}
