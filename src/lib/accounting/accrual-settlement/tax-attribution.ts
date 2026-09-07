import { roundMoney } from "../payment-fees";

export type TaxableBillLine = {
  lineKey: string;
  amount: number;
  account_id: string | null;
  taxAmount?: number;
  /** When false, line is excluded from proportional tax fallback. Default true when unset. */
  taxable?: boolean;
  occurrenceId?: string | null;
  settlesAccrual?: boolean;
  accountType?: string | null;
  recoverableInputTax?: boolean;
};

export type ResolvedLineTaxAttribution = {
  lineKey: string;
  subtotal: number;
  taxAmount: number;
  nonrecoverableTax: number;
  recoverableTax: number;
  accountId: string;
  occurrenceId: string | null;
  isSettlementLine: boolean;
};

export class PurchaseTaxAttributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseTaxAttributionError";
  }
}

export function proportionalTaxAllocation(input: {
  totalTax: number;
  lines: Array<{ lineKey: string; taxableAmount: number }>;
}): Map<string, number> {
  const map = new Map<string, number>();
  const totalTax = roundMoney(input.totalTax);
  const taxableTotal = roundMoney(input.lines.reduce((sum, line) => sum + line.taxableAmount, 0));
  if (totalTax <= 0 || taxableTotal <= 0) return map;

  let assigned = 0;
  const eligible = input.lines.filter((line) => line.taxableAmount > 0);
  for (let index = 0; index < eligible.length; index += 1) {
    const line = eligible[index];
    if (index === eligible.length - 1) {
      map.set(line.lineKey, roundMoney(totalTax - assigned));
    } else {
      const share = roundMoney((line.taxableAmount / taxableTotal) * totalTax);
      map.set(line.lineKey, share);
      assigned = roundMoney(assigned + share);
    }
  }
  return map;
}

function isSettlementLine(line: TaxableBillLine, hasAccrualAllocations: boolean): boolean {
  if (!hasAccrualAllocations) return false;
  return line.settlesAccrual !== false;
}

function splitRecoverableTax(
  taxAmount: number,
  recoverable: boolean,
  recoverableInputTaxAccountId?: string | null,
): { nonrecoverableTax: number; recoverableTax: number } {
  const tax = roundMoney(taxAmount);
  if (tax <= 0) return { nonrecoverableTax: 0, recoverableTax: 0 };
  if (recoverable && recoverableInputTaxAccountId) {
    return { nonrecoverableTax: 0, recoverableTax: tax };
  }
  return { nonrecoverableTax: tax, recoverableTax: 0 };
}

/**
 * Resolve purchase tax to bill lines.
 * Priority: explicit line tax → taxable metadata proportional fallback → error.
 */
export function resolveLineTaxAttribution(input: {
  billLines: TaxableBillLine[];
  totalTaxAmount: number;
  hasAccrualAllocations: boolean;
  recoverableInputTaxAccountId?: string | null;
}): ResolvedLineTaxAttribution[] {
  const totalTaxAmount = roundMoney(input.totalTaxAmount);
  const lines = input.billLines.filter((line) => line.amount > 0 || (line.taxAmount ?? 0) > 0);
  if (totalTaxAmount <= 0) {
    return lines.map((line) => ({
      lineKey: line.lineKey,
      subtotal: roundMoney(line.amount),
      taxAmount: 0,
      nonrecoverableTax: 0,
      recoverableTax: 0,
      accountId: line.account_id as string,
      occurrenceId: line.occurrenceId ?? null,
      isSettlementLine: isSettlementLine(line, input.hasAccrualAllocations),
    }));
  }

  const explicitSum = roundMoney(lines.reduce((sum, line) => sum + (line.taxAmount ?? 0), 0));
  const hasExplicitLineTax = lines.some((line) => line.taxAmount != null && line.taxAmount > 0);
  const taxByLine = new Map<string, number>();

  if (hasExplicitLineTax) {
    for (const line of lines) {
      taxByLine.set(line.lineKey, roundMoney(line.taxAmount ?? 0));
    }
    const assigned = roundMoney([...taxByLine.values()].reduce((sum, value) => sum + value, 0));
    if (Math.abs(assigned - totalTaxAmount) > 0.02) {
      throw new PurchaseTaxAttributionError(
        `Explicit line tax (${assigned.toFixed(2)}) must equal bill purchase tax (${totalTaxAmount.toFixed(2)})`,
      );
    }
  } else {
    const taxableLines = lines.filter((line) => line.taxable !== false && line.amount > 0);
    if (taxableLines.length === 0) {
      throw new PurchaseTaxAttributionError(
        "Purchase tax attribution requires explicit line tax amounts or taxable bill lines",
      );
    }
    const hasTaxableMetadata = lines.some((line) => line.taxable != null);
    if (!hasTaxableMetadata && lines.some((line) => line.taxable === false)) {
      throw new PurchaseTaxAttributionError(
        "Purchase tax attribution requires explicit line tax amounts when bill mixes taxable and nontaxable lines",
      );
    }
    const shares = proportionalTaxAllocation({
      totalTax: totalTaxAmount,
      lines: taxableLines.map((line) => ({ lineKey: line.lineKey, taxableAmount: line.amount })),
    });
    for (const line of lines) {
      taxByLine.set(line.lineKey, shares.get(line.lineKey) ?? 0);
    }
  }

  return lines.map((line) => {
    const taxAmount = roundMoney(taxByLine.get(line.lineKey) ?? 0);
    const { nonrecoverableTax, recoverableTax } = splitRecoverableTax(
      taxAmount,
      Boolean(line.recoverableInputTax),
      input.recoverableInputTaxAccountId,
    );
    return {
      lineKey: line.lineKey,
      subtotal: roundMoney(line.amount),
      taxAmount,
      nonrecoverableTax,
      recoverableTax,
      accountId: line.account_id as string,
      occurrenceId: line.occurrenceId ?? null,
      isSettlementLine: isSettlementLine(line, input.hasAccrualAllocations),
    };
  });
}

export function sumAttributedTax(lines: ResolvedLineTaxAttribution[]): number {
  return roundMoney(lines.reduce((sum, line) => sum + line.taxAmount, 0));
}
