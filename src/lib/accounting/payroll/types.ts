/** Provider-neutral payroll component categories. */
export const PAYROLL_COMPONENT_CATEGORIES = {
  GROSS_WAGES: "gross_wages",
  OVERTIME: "overtime",
  BONUS: "bonus",
  COMMISSION: "commission",
  PTO: "pto",
  SICK_PAY: "sick_pay",
  REIMBURSEMENT: "reimbursement",
  EMPLOYER_PAYROLL_TAX: "employer_payroll_tax",
  EMPLOYER_FICA_LIABILITY: "employer_fica_liability",
  EMPLOYEE_FEDERAL_WITHHOLDING: "employee_federal_withholding",
  EMPLOYEE_STATE_WITHHOLDING: "employee_state_withholding",
  EMPLOYEE_FICA: "employee_fica",
  BENEFITS_WITHHELD: "benefits_withheld",
  RETIREMENT_WITHHELD: "retirement_withheld",
  OTHER_DEDUCTION: "other_deduction",
  OTHER_EMPLOYER_PAYROLL_TAX: "other_employer_payroll_tax",
  NET_PAY: "net_pay",
} as const;

export type PayrollComponentCategory =
  (typeof PAYROLL_COMPONENT_CATEGORIES)[keyof typeof PAYROLL_COMPONENT_CATEGORIES];

/** Categories that debit expense (recognition). */
export const EXPENSE_COMPONENT_CATEGORIES = new Set<PayrollComponentCategory>([
  PAYROLL_COMPONENT_CATEGORIES.GROSS_WAGES,
  PAYROLL_COMPONENT_CATEGORIES.OVERTIME,
  PAYROLL_COMPONENT_CATEGORIES.BONUS,
  PAYROLL_COMPONENT_CATEGORIES.COMMISSION,
  PAYROLL_COMPONENT_CATEGORIES.PTO,
  PAYROLL_COMPONENT_CATEGORIES.SICK_PAY,
  PAYROLL_COMPONENT_CATEGORIES.REIMBURSEMENT,
  PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_PAYROLL_TAX,
]);

/** Categories that credit liability/clearing. */
export const LIABILITY_COMPONENT_CATEGORIES = new Set<PayrollComponentCategory>([
  PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FEDERAL_WITHHOLDING,
  PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_STATE_WITHHOLDING,
  PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FICA,
  PAYROLL_COMPONENT_CATEGORIES.BENEFITS_WITHHELD,
  PAYROLL_COMPONENT_CATEGORIES.RETIREMENT_WITHHELD,
  PAYROLL_COMPONENT_CATEGORIES.OTHER_DEDUCTION,
  PAYROLL_COMPONENT_CATEGORIES.OTHER_EMPLOYER_PAYROLL_TAX,
  PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_FICA_LIABILITY,
  PAYROLL_COMPONENT_CATEGORIES.NET_PAY,
]);

export const REQUIRED_MAPPING_CATEGORIES: PayrollComponentCategory[] = [
  PAYROLL_COMPONENT_CATEGORIES.GROSS_WAGES,
  PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_PAYROLL_TAX,
  PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FEDERAL_WITHHOLDING,
  PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_STATE_WITHHOLDING,
  PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FICA,
  PAYROLL_COMPONENT_CATEGORIES.NET_PAY,
];

export type PayrollRunStatus =
  | "draft"
  | "imported"
  | "reviewed"
  | "posted"
  | "reversed"
  | "needs_review";

export type WorkerType = "employee" | "contractor";
export type LaborType = "direct" | "indirect" | "overhead" | "pto" | "training" | "unallocated";

export type PayrollComponentInput = {
  category: PayrollComponentCategory;
  amount: number;
  workerId?: string | null;
};

export type PayrollAccountMapping = {
  componentCategory: PayrollComponentCategory;
  accountId: string;
  side: "debit" | "credit";
  isRequired?: boolean;
  /** When set, uses this amount instead of the full component total (split mappings). */
  fixedAmount?: number;
};

export type LaborAllocationInput = {
  workerId: string;
  jobId?: string | null;
  workDate: string;
  hours?: number | null;
  grossAmount: number;
  laborType: LaborType;
  externalEntryId?: string | null;
};

export type CanonicalPayrollImport = {
  provider: string;
  externalRunId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  components: PayrollComponentInput[];
  laborAllocations: LaborAllocationInput[];
  sourceMetadata?: Record<string, unknown>;
};

export type PayrollRunPreview = {
  grossWages: number;
  employeeTaxes: number;
  employeeDeductions: number;
  employerTaxes: number;
  netPay: number;
  totalDebits: number;
  totalCredits: number;
  balanced: boolean;
  missingMappings: PayrollComponentCategory[];
  warnings: string[];
  errors: string[];
  journalLines: Array<{
    accountId: string;
    debit: number;
    credit: number;
    memo: string;
    jobId?: string | null;
    costClassification?: string | null;
  }>;
  laborSummary: {
    assignedGross: number;
    unassignedGross: number;
    assignedBurden: number;
    unassignedBurden: number;
  };
};

export function payrollRunIdempotencyKey(provider: string, externalRunId: string): string {
  return `payroll:${provider}:${externalRunId}`;
}

export function payrollSettlementIdempotencyKey(
  settlementType: string,
  payrollRunId: string,
  amount: number,
): string {
  return `payroll-settlement:${settlementType}:${payrollRunId}:${amount.toFixed(2)}`;
}

/** Fields Teller must NOT store in Phase 12. */
export const SENSITIVE_PAYROLL_FIELDS = [
  "ssn",
  "social_security_number",
  "bank_account",
  "routing_number",
  "date_of_birth",
  "home_address",
  "tax_elections",
  "w2",
  "941",
] as const;

export function assertNoSensitivePayrollFields(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    const normalized = key.toLowerCase().replace(/[-_]/g, "");
    for (const sensitive of SENSITIVE_PAYROLL_FIELDS) {
      const needle = sensitive.replace(/[-_]/g, "");
      if (normalized.includes(needle)) {
        throw new Error(`Sensitive payroll field "${key}" must not be stored in Teller`);
      }
    }
  }
}
