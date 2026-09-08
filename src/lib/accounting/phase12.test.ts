import { describe, expect, it } from "vitest";
import {
  buildPayrollRecognitionJournalLines,
  buildPayrollSettlementJournalLines,
  assertPayrollJournalBalanced,
  computePayrollTotals,
  settlementCreatesExpense,
} from "./payroll/journal-lines";
import { allocateEmployerBurden, summarizeLaborAllocations } from "./payroll/labor-allocation";
import { normalizeProviderPayload, previewPayrollRun } from "./payroll/import-normalizer";
import { reconcileJobLaborEconomics } from "./payroll/reconciliation";
import { PAYROLL_COMPONENT_CATEGORIES, assertNoSensitivePayrollFields } from "./payroll/types";
import { assertHfacPayrollHardRefusal } from "./payroll/hfac-boundary";
import { TELLER_HFAC_ORG_ID } from "@/lib/integration/controlled-prod-test";
import {
  computeActualDirectCostWithLabor,
  summarizeLaborForJob,
} from "./job-profitability";

const WAGE = "wage";
const ER = "er-tax";
const FED = "fed";
const STATE = "state";
const FICA = "fica";
const CLEAR = "clear";

const mappings = [
  { componentCategory: PAYROLL_COMPONENT_CATEGORIES.GROSS_WAGES, accountId: WAGE, side: "debit" as const },
  { componentCategory: PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_PAYROLL_TAX, accountId: ER, side: "debit" as const },
  { componentCategory: PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_FICA_LIABILITY, accountId: FICA, side: "credit" as const },
  { componentCategory: PAYROLL_COMPONENT_CATEGORIES.OTHER_EMPLOYER_PAYROLL_TAX, accountId: "other-tax", side: "credit" as const },
  { componentCategory: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FEDERAL_WITHHOLDING, accountId: FED, side: "credit" as const },
  { componentCategory: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_STATE_WITHHOLDING, accountId: STATE, side: "credit" as const },
  { componentCategory: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FICA, accountId: FICA, side: "credit" as const },
  { componentCategory: PAYROLL_COMPONENT_CATEGORIES.NET_PAY, accountId: CLEAR, side: "credit" as const },
];

const components = [
  { category: PAYROLL_COMPONENT_CATEGORIES.GROSS_WAGES, amount: 10000 },
  { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FEDERAL_WITHHOLDING, amount: 1200 },
  { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_STATE_WITHHOLDING, amount: 400 },
  { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FICA, amount: 765 },
  { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_PAYROLL_TAX, amount: 965 },
  { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_FICA_LIABILITY, amount: 765 },
  { category: PAYROLL_COMPONENT_CATEGORIES.OTHER_EMPLOYER_PAYROLL_TAX, amount: 200 },
  { category: PAYROLL_COMPONENT_CATEGORIES.NET_PAY, amount: 7635 },
];

describe("Phase 12 payroll journal", () => {
  it("builds balanced recognition journal", () => {
    const lines = buildPayrollRecognitionJournalLines({ components, mappings });
    expect(() => assertPayrollJournalBalanced(lines)).not.toThrow();
  });

  it("computes payroll totals", () => {
    const totals = computePayrollTotals(components);
    expect(totals.grossWages).toBe(10000);
    expect(totals.netPay).toBe(7635);
    expect(totals.employerTaxes).toBe(965);
  });

  it("settlement does not recreate wage expense", () => {
    const lines = buildPayrollSettlementJournalLines({
      settlementType: "net_pay",
      amount: 7635,
      liabilityAccountId: CLEAR,
      cashAccountId: "cash",
    });
    expect(settlementCreatesExpense(lines, WAGE)).toBe(false);
  });
});

describe("Phase 12 labor allocation", () => {
  it("allocates employer burden proportionally", () => {
    const rows = allocateEmployerBurden({
      totalEmployerBurden: 76.5,
      destinations: [
        { key: "a", jobId: "j1", laborType: "direct", grossAmount: 600 },
        { key: "b", jobId: "j2", laborType: "direct", grossAmount: 400 },
      ],
    });
    expect(rows[0]!.burdenAmount).toBeCloseTo(45.9, 1);
    expect(rows[1]!.burdenAmount).toBeCloseTo(30.6, 1);
  });

  it("summarizes direct vs unallocated labor", () => {
    const s = summarizeLaborAllocations([
      { workerId: "w1", jobId: "j1", workDate: "2026-01-01", grossAmount: 600, laborType: "direct" },
      { workerId: "w1", jobId: null, workDate: "2026-01-01", grossAmount: 400, laborType: "unallocated" },
    ]);
    expect(s.directGross).toBe(600);
    expect(s.unallocatedGross).toBe(400);
  });

  it("integrates labor into job profitability", () => {
    const labor = summarizeLaborForJob("j1", [
      { job_id: "j1", gross_amount: 1000, employer_burden_amount: 76.5, labor_type: "direct" },
    ]);
    expect(computeActualDirectCostWithLabor(500, labor.directLaborCost, labor.employerLaborBurden)).toBe(1576.5);
  });
});

describe("Phase 12 import & security", () => {
  it("normalizes csv provider payload", () => {
    const canonical = normalizeProviderPayload("csv", {
      externalRunId: "run-1",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-15",
      payDate: "2026-01-20",
      components,
      laborAllocations: [],
    });
    expect(canonical.externalRunId).toBe("run-1");
  });

  it("blocks sensitive payroll fields", () => {
    expect(() => assertNoSensitivePayrollFields({ bank_account: "123" })).toThrow();
  });

  it("refuses HFAC payroll mutations", () => {
    expect(() => assertHfacPayrollHardRefusal(TELLER_HFAC_ORG_ID)).toThrow();
  });

  it("preview requires mappings", () => {
    const preview = previewPayrollRun({
      components,
      mappings: [],
      wageExpenseAccountId: WAGE,
      employerTaxExpenseAccountId: ER,
    });
    expect(preview.errors.length).toBeGreaterThan(0);
  });

  it("reconciles job labor economics", () => {
    const r = reconcileJobLaborEconomics({
      grossWages: 1000,
      laborAllocations: [
        { jobId: "j1", grossAmount: 600 },
        { jobId: "j2", grossAmount: 400 },
      ],
    });
    expect(r.balanced).toBe(true);
  });
});
