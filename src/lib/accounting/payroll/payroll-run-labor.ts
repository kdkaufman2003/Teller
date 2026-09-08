import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PAYROLL_COMPONENT_CATEGORIES,
  type LaborAllocationInput,
  type PayrollAccountMapping,
  type PayrollComponentInput,
} from "./types";
import { allocateEmployerBurden } from "./labor-allocation";
import { roundMoney } from "../payment-fees";
import { postPayrollRun } from "./payroll-service";

export async function ensurePayrollAccountMappings(
  supabase: SupabaseClient,
  organizationId: string,
  accounts: {
    wageExpenseId: string;
    employerTaxExpenseId: string;
    federalPayableId: string;
    statePayableId: string;
    ficaPayableId: string;
    otherTaxPayableId: string;
    benefitsPayableId: string;
    retirementPayableId: string;
    clearingId: string;
  },
): Promise<PayrollAccountMapping[]> {
  const rows: Array<{ component_category: string; account_id: string; side: string; is_required: boolean; metadata?: Record<string, unknown> }> = [
    { component_category: PAYROLL_COMPONENT_CATEGORIES.GROSS_WAGES, account_id: accounts.wageExpenseId, side: "debit", is_required: true },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.OVERTIME, account_id: accounts.wageExpenseId, side: "debit", is_required: false },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.BONUS, account_id: accounts.wageExpenseId, side: "debit", is_required: false },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.COMMISSION, account_id: accounts.wageExpenseId, side: "debit", is_required: false },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.PTO, account_id: accounts.wageExpenseId, side: "debit", is_required: false },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.SICK_PAY, account_id: accounts.wageExpenseId, side: "debit", is_required: false },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.REIMBURSEMENT, account_id: accounts.wageExpenseId, side: "debit", is_required: false },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_PAYROLL_TAX, account_id: accounts.employerTaxExpenseId, side: "debit", is_required: true },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_FICA_LIABILITY, account_id: accounts.ficaPayableId, side: "credit", is_required: true },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.OTHER_EMPLOYER_PAYROLL_TAX, account_id: accounts.otherTaxPayableId, side: "credit", is_required: false },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FEDERAL_WITHHOLDING, account_id: accounts.federalPayableId, side: "credit", is_required: true },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_STATE_WITHHOLDING, account_id: accounts.statePayableId, side: "credit", is_required: true },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FICA, account_id: accounts.ficaPayableId, side: "credit", is_required: true },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.BENEFITS_WITHHELD, account_id: accounts.benefitsPayableId, side: "credit", is_required: false },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.RETIREMENT_WITHHELD, account_id: accounts.retirementPayableId, side: "credit", is_required: false },
    { component_category: PAYROLL_COMPONENT_CATEGORIES.NET_PAY, account_id: accounts.clearingId, side: "credit", is_required: true },
  ];

  for (const row of rows) {
    const { data: existing } = await supabase
      .from("teller_payroll_account_mappings")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("component_category", row.component_category)
      .maybeSingle();
    if (existing?.id) continue;
    const { error } = await supabase.from("teller_payroll_account_mappings").insert({
      organization_id: organizationId,
      component_category: row.component_category,
      account_id: row.account_id,
      side: row.side,
      is_required: row.is_required,
      metadata: row.metadata ?? {},
    });
    if (error) throw new Error(error.message);
  }

  const { data } = await supabase
    .from("teller_payroll_account_mappings")
    .select("component_category, account_id, side, is_required, metadata")
    .eq("organization_id", organizationId);

  return (data ?? []).map((row) => ({
    componentCategory: row.component_category as PayrollAccountMapping["componentCategory"],
    accountId: row.account_id as string,
    side: row.side as "debit" | "credit",
    isRequired: row.is_required as boolean,
    fixedAmount:
      row.component_category === PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_PAYROLL_TAX &&
      row.side === "credit" &&
      (row.metadata as Record<string, unknown> | null)?.role === "employer_fica"
        ? undefined
        : undefined,
  }));
}

export async function loadPayrollMappingsFromDb(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<PayrollAccountMapping[]> {
  const { data, error } = await supabase
    .from("teller_payroll_account_mappings")
    .select("component_category, account_id, side, is_required")
    .eq("organization_id", organizationId);
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    componentCategory: row.component_category as PayrollAccountMapping["componentCategory"],
    accountId: row.account_id as string,
    side: row.side as "debit" | "credit",
    isRequired: row.is_required as boolean,
  }));
}

export async function createWorker(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    displayName: string;
    externalProvider?: string;
    externalWorkerId?: string;
    workerType?: "employee" | "contractor";
    partyId?: string | null;
  },
): Promise<string> {
  const { data, error } = await supabase
    .from("teller_workers")
    .insert({
      organization_id: input.organizationId,
      display_name: input.displayName,
      external_provider: input.externalProvider ?? "manual",
      external_worker_id: input.externalWorkerId ?? null,
      worker_type: input.workerType ?? "employee",
      party_id: input.partyId ?? null,
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not create worker");
  return data.id as string;
}

export function standardPayrollComponents(input?: {
  gross?: number;
  federal?: number;
  state?: number;
  employeeFica?: number;
  employerFica?: number;
  otherEmployerTax?: number;
  benefits?: number;
  retirement?: number;
  net?: number;
}): PayrollComponentInput[] {
  const gross = input?.gross ?? 10000;
  const federal = input?.federal ?? 1200;
  const state = input?.state ?? 400;
  const employeeFica = input?.employeeFica ?? 765;
  const employerFica = input?.employerFica ?? 765;
  const otherEmployerTax = input?.otherEmployerTax ?? 200;
  const net = input?.net ?? 7635;
  const components: PayrollComponentInput[] = [
    { category: PAYROLL_COMPONENT_CATEGORIES.GROSS_WAGES, amount: gross },
    { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FEDERAL_WITHHOLDING, amount: federal },
    { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_STATE_WITHHOLDING, amount: state },
    { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYEE_FICA, amount: employeeFica },
    { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_PAYROLL_TAX, amount: roundMoney(employerFica + otherEmployerTax) },
    { category: PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_FICA_LIABILITY, amount: employerFica },
    { category: PAYROLL_COMPONENT_CATEGORIES.OTHER_EMPLOYER_PAYROLL_TAX, amount: otherEmployerTax },
    { category: PAYROLL_COMPONENT_CATEGORIES.NET_PAY, amount: net },
  ];
  if (input?.benefits) {
    components.push({ category: PAYROLL_COMPONENT_CATEGORIES.BENEFITS_WITHHELD, amount: input.benefits });
  }
  if (input?.retirement) {
    components.push({ category: PAYROLL_COMPONENT_CATEGORIES.RETIREMENT_WITHHELD, amount: input.retirement });
  }
  return components;
}

export async function postPayrollRunWithLabor(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    provider: string;
    externalRunId: string;
    payDate: string;
    periodStart: string;
    periodEnd: string;
    components: PayrollComponentInput[];
    laborAllocations: LaborAllocationInput[];
    mappings: PayrollAccountMapping[];
    wageExpenseAccountId: string;
    employerTaxExpenseAccountId: string;
    operationId?: string;
  },
): Promise<{ payrollRunId: string; journalEntryId: string }> {
  const employerTaxTotal = input.components
    .filter((row) => row.category === PAYROLL_COMPONENT_CATEGORIES.EMPLOYER_PAYROLL_TAX)
    .reduce((sum, row) => sum + row.amount, 0);

  const burdenRows = allocateEmployerBurden({
    totalEmployerBurden: employerTaxTotal,
    destinations: input.laborAllocations.map((row, index) => ({
      key: `${row.workerId}:${row.jobId ?? "none"}:${row.laborType}:${index}`,
      jobId: row.jobId ?? null,
      laborType: row.laborType,
      grossAmount: row.laborType === "direct" ? row.grossAmount : 0,
    })),
  });
  const burdenByKey = new Map(burdenRows.map((row) => [row.destinationKey, row.burdenAmount]));

  const result = await postPayrollRun(supabase, {
    organizationId: input.organizationId,
    provider: input.provider,
    externalRunId: input.externalRunId,
    payDate: input.payDate,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    components: input.components,
    mappings: input.mappings,
    wageExpenseAccountId: input.wageExpenseAccountId,
    employerTaxExpenseAccountId: input.employerTaxExpenseAccountId,
    operationId: input.operationId,
  });

  const { count: existingComponents } = await supabase
    .from("teller_payroll_components")
    .select("id", { count: "exact", head: true })
    .eq("payroll_run_id", result.payrollRunId);
  const { count: existingLabor } = await supabase
    .from("teller_labor_entries")
    .select("id", { count: "exact", head: true })
    .eq("payroll_run_id", result.payrollRunId);

  if (
    (existingComponents ?? 0) >= input.components.length &&
    (existingLabor ?? 0) >= input.laborAllocations.length
  ) {
    return result;
  }

  if ((existingComponents ?? 0) < input.components.length) {
    for (const row of input.components) {
      const { data: existingRow } = await supabase
        .from("teller_payroll_components")
        .select("id")
        .eq("payroll_run_id", result.payrollRunId)
        .eq("component_category", row.category)
        .maybeSingle();
      if (existingRow?.id) continue;
      const { error } = await supabase.from("teller_payroll_components").insert({
        organization_id: input.organizationId,
        payroll_run_id: result.payrollRunId,
        component_category: row.category,
        amount: row.amount,
        side: row.category === PAYROLL_COMPONENT_CATEGORIES.GROSS_WAGES ? "debit" : "credit",
        worker_id: row.workerId ?? null,
      });
      if (error) throw new Error(error.message);
    }
  }

  for (let i = 0; i < input.laborAllocations.length; i++) {
    const row = input.laborAllocations[i]!;
    const key = `${row.workerId}:${row.jobId ?? "none"}:${row.laborType}:${i}`;
    const externalEntryId = row.externalEntryId ?? `${input.externalRunId}:${i}`;
    const { data: existingEntry } = await supabase
      .from("teller_labor_entries")
      .select("id")
      .eq("organization_id", input.organizationId)
      .eq("source", input.provider)
      .eq("external_entry_id", externalEntryId)
      .maybeSingle();
    if (existingEntry?.id) continue;
    const { error } = await supabase.from("teller_labor_entries").insert({
      organization_id: input.organizationId,
      worker_id: row.workerId,
      payroll_run_id: result.payrollRunId,
      job_id: row.jobId ?? null,
      work_date: row.workDate,
      hours: row.hours ?? null,
      labor_type: row.laborType,
      gross_amount: row.grossAmount,
      employer_burden_amount: burdenByKey.get(key) ?? 0,
      source: input.provider,
      external_entry_id: externalEntryId,
      allocation_status: row.jobId ? "allocated" : "unallocated",
    });
    if (error?.code === "23505") continue;
    if (error) throw new Error(error.message);
  }

  return result;
}
