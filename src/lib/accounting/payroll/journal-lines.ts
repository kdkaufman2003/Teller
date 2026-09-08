import { roundMoney } from "../payment-fees";
import {
  EXPENSE_COMPONENT_CATEGORIES,
  LIABILITY_COMPONENT_CATEGORIES,
  PAYROLL_COMPONENT_CATEGORIES,
  type PayrollAccountMapping,
  type PayrollComponentCategory,
  type PayrollComponentInput,
} from "./types";

export type PayrollJournalLine = {
  accountId: string;
  debit: number;
  credit: number;
  memo: string;
  jobId?: string | null;
  costClassification?: string | null;
  jobCostCategoryId?: string | null;
};

export function defaultMappingSide(category: PayrollComponentCategory): "debit" | "credit" {
  if (EXPENSE_COMPONENT_CATEGORIES.has(category)) return "debit";
  if (LIABILITY_COMPONENT_CATEGORIES.has(category)) return "credit";
  return "credit";
}

export function resolveAccountForCategory(
  category: PayrollComponentCategory,
  mappings: PayrollAccountMapping[],
): string | null {
  return mappings.find((row) => row.componentCategory === category)?.accountId ?? null;
}

export function aggregateComponents(components: PayrollComponentInput[]): Map<PayrollComponentCategory, number> {
  const totals = new Map<PayrollComponentCategory, number>();
  for (const row of components) {
    totals.set(row.category, roundMoney((totals.get(row.category) ?? 0) + row.amount));
  }
  return totals;
}

export function computePayrollTotals(components: PayrollComponentInput[]) {
  const totals = aggregateComponents(components);
  const grossWages =
    (totals.get(PAYROLL_COMPONENT_CATEGORIES.GROSS_WAGES) ?? 0) +
    (totals.get(PAYROLL_COMPONENT_CATEGORIES.OVERTIME) ?? 0) +
    (totals.get(PAYROLL_COMPONENT_CATEGORIES.BONUS) ?? 0) +
    (totals.get(PAYROLL_COMPONENT_CATEGORIES.COMMISSION) ?? 0) +
    (totals.get(PAYROLL_COMPONENT_CATEGORIES.PTO) ?? 0) +
    (totals.get(PAYROLL_COMPONENT_CATEGORIES.SICK_PAY) ?? 0) +
    (totals.get(PAYROLL_COMPONENT_CATEGORIES.REIMBURSEMENT) ?? 0);

  const employeeTaxes =
    (totals.get(PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FEDERAL_WITHHOLDING) ?? 0) +
    (totals.get(PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_STATE_WITHHOLDING) ?? 0) +
    (totals.get(PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FICA) ?? 0);

  const employeeDeductions =
    (totals.get(PAYROLL_COMPONENT_CATEGORIES.BENEFITS_WITHHELD) ?? 0) +
    (totals.get(PAYROLL_COMPONENT_CATEGORIES.RETIREMENT_WITHHELD) ?? 0) +
    (totals.get(PAYROLL_COMPONENT_CATEGORIES.OTHER_DEDUCTION) ?? 0);

  const employerTaxes = totals.get(PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_PAYROLL_TAX) ?? 0;
  const netPay = totals.get(PAYROLL_COMPONENT_CATEGORIES.NET_PAY) ?? 0;
  const totalLiability = roundMoney(employeeTaxes + employeeDeductions + netPay + employerTaxes);

  return {
    grossWages: roundMoney(grossWages),
    employeeTaxes: roundMoney(employeeTaxes),
    employeeDeductions: roundMoney(employeeDeductions),
    employerTaxes: roundMoney(employerTaxes),
    netPay: roundMoney(netPay),
    totalLiability,
  };
}

export function buildPayrollRecognitionJournalLines(input: {
  components: PayrollComponentInput[];
  mappings: PayrollAccountMapping[];
  laborJobLines?: PayrollJournalLine[];
}): PayrollJournalLine[] {
  const totals = aggregateComponents(input.components);
  const lines: PayrollJournalLine[] = [];

  for (const [category, amount] of totals.entries()) {
    if (amount <= 0.009) continue;
    const categoryMappings = input.mappings.filter((row) => row.componentCategory === category);
    if (categoryMappings.length) {
      let fixedTotal = 0;
      for (const mapping of categoryMappings) {
        const lineAmount =
          mapping.fixedAmount != null ? roundMoney(mapping.fixedAmount) : roundMoney(amount - fixedTotal);
        if (mapping.fixedAmount != null) fixedTotal = roundMoney(fixedTotal + lineAmount);
        if (lineAmount <= 0.009) continue;
        lines.push({
          accountId: mapping.accountId,
          debit: mapping.side === "debit" ? lineAmount : 0,
          credit: mapping.side === "credit" ? lineAmount : 0,
          memo: `Payroll ${category}`,
        });
      }
      continue;
    }
    const accountId = resolveAccountForCategory(category, input.mappings);
    if (!accountId) continue;
    const side = defaultMappingSide(category);
    lines.push({
      accountId,
      debit: side === "debit" ? amount : 0,
      credit: side === "credit" ? amount : 0,
      memo: `Payroll ${category}`,
    });
  }

  if (input.laborJobLines?.length) {
    lines.push(...input.laborJobLines);
  }

  return lines;
}

export function assertPayrollJournalBalanced(lines: PayrollJournalLine[]): void {
  const debit = roundMoney(lines.reduce((sum, row) => sum + row.debit, 0));
  const credit = roundMoney(lines.reduce((sum, row) => sum + row.credit, 0));
  if (Math.abs(debit - credit) > 0.009) {
    throw new Error(`Payroll journal unbalanced: debit ${debit} vs credit ${credit}`);
  }
}

export function buildPayrollReversalLines(lines: PayrollJournalLine[]): PayrollJournalLine[] {
  return lines.map((row) => ({
    ...row,
    debit: row.credit,
    credit: row.debit,
    memo: `Reversal: ${row.memo}`,
  }));
}

export function buildPayrollSettlementJournalLines(input: {
  settlementType: "net_pay" | "tax" | "benefit" | "other";
  amount: number;
  liabilityAccountId: string;
  cashAccountId: string;
}): PayrollJournalLine[] {
  return [
    {
      accountId: input.liabilityAccountId,
      debit: input.amount,
      credit: 0,
      memo: `Payroll ${input.settlementType} settlement`,
    },
    {
      accountId: input.cashAccountId,
      debit: 0,
      credit: input.amount,
      memo: `Payroll ${input.settlementType} settlement`,
    },
  ];
}

export function sumJournalDebits(lines: PayrollJournalLine[]): number {
  return roundMoney(lines.reduce((sum, row) => sum + row.debit, 0));
}

export function sumJournalCredits(lines: PayrollJournalLine[]): number {
  return roundMoney(lines.reduce((sum, row) => sum + row.credit, 0));
}

/** Settlement must not create wage expense — only liability relief + cash. */
export function settlementCreatesExpense(lines: PayrollJournalLine[], wageExpenseAccountId: string): boolean {
  return lines.some(
    (row) => row.accountId === wageExpenseAccountId && row.debit > 0.009,
  );
}
