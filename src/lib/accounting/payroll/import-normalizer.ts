import {
  REQUIRED_MAPPING_CATEGORIES,
  type CanonicalPayrollImport,
  type PayrollAccountMapping,
  type PayrollComponentCategory,
  type PayrollComponentInput,
  assertNoSensitivePayrollFields,
} from "./types";
import { roundMoney } from "../payment-fees";
import {
  buildPayrollRecognitionJournalLines,
  computePayrollTotals,
  resolveAccountForCategory,
  sumJournalCredits,
  sumJournalDebits,
  type PayrollJournalLine,
} from "./journal-lines";
import {
  allocateEmployerBurden,
  costClassificationForLaborType,
  summarizeLaborAllocations,
  validateLaborAllocationOrgScope,
} from "./labor-allocation";
import type { PayrollRunPreview } from "./types";

export type ProviderPayload = Record<string, unknown>;

/** Provider-neutral normalization — no provider-specific structures leak into accounting engine. */
export function normalizeProviderPayload(
  provider: string,
  payload: ProviderPayload,
): CanonicalPayrollImport {
  assertNoSensitivePayrollFields(payload);

  if (provider === "csv" || provider === "manual" || provider === "json") {
    const components = (payload.components as PayrollComponentInput[]) ?? [];
    const laborAllocations = (payload.laborAllocations as CanonicalPayrollImport["laborAllocations"]) ?? [];
    return {
      provider,
      externalRunId: String(payload.externalRunId ?? payload.external_run_id ?? ""),
      periodStart: String(payload.periodStart ?? payload.period_start ?? ""),
      periodEnd: String(payload.periodEnd ?? payload.period_end ?? ""),
      payDate: String(payload.payDate ?? payload.pay_date ?? ""),
      components,
      laborAllocations,
      sourceMetadata: (payload.sourceMetadata as Record<string, unknown>) ?? {},
    };
  }

  // Generic adapter shape for future Gusto/ADP/etc.
  const run = (payload.run as Record<string, unknown>) ?? payload;
  const lines = (run.lineItems as Array<Record<string, unknown>>) ?? (run.components as Array<Record<string, unknown>>) ?? [];
  const components: PayrollComponentInput[] = lines.map((row) => ({
    category: String(row.category ?? row.type ?? "gross_wages") as PayrollComponentCategory,
    amount: roundMoney(Number(row.amount ?? 0)),
    workerId: (row.workerId as string | null) ?? null,
  }));

  const laborRaw = (run.labor as Array<Record<string, unknown>>) ?? [];
  const laborAllocations = laborRaw.map((row) => ({
    workerId: String(row.workerId ?? ""),
    jobId: (row.jobId as string | null) ?? null,
    workDate: String(row.workDate ?? run.payDate ?? ""),
    hours: row.hours == null ? null : Number(row.hours),
    grossAmount: roundMoney(Number(row.grossAmount ?? row.amount ?? 0)),
    laborType: (row.laborType as CanonicalPayrollImport["laborAllocations"][number]["laborType"]) ?? "direct",
    externalEntryId: (row.externalEntryId as string | null) ?? null,
  }));

  return {
    provider,
    externalRunId: String(run.externalRunId ?? run.id ?? ""),
    periodStart: String(run.periodStart ?? ""),
    periodEnd: String(run.periodEnd ?? ""),
    payDate: String(run.payDate ?? ""),
    components,
    laborAllocations,
    sourceMetadata: { rawProvider: provider },
  };
}

export function findMissingMappings(
  components: PayrollComponentInput[],
  mappings: PayrollAccountMapping[],
): PayrollComponentCategory[] {
  const used = new Set(components.filter((row) => row.amount > 0.009).map((row) => row.category));
  const missing: PayrollComponentCategory[] = [];
  for (const category of REQUIRED_MAPPING_CATEGORIES) {
    if (used.has(category) && !resolveAccountForCategory(category, mappings)) {
      missing.push(category);
    }
  }
  for (const category of used) {
    if (!REQUIRED_MAPPING_CATEGORIES.includes(category) && !resolveAccountForCategory(category, mappings)) {
      missing.push(category);
    }
  }
  return [...new Set(missing)];
}

export function previewPayrollRun(input: {
  components: PayrollComponentInput[];
  mappings: PayrollAccountMapping[];
  laborAllocations?: CanonicalPayrollImport["laborAllocations"];
  wageExpenseAccountId: string;
  employerTaxExpenseAccountId: string;
}): PayrollRunPreview {
  const totals = computePayrollTotals(input.components);
  const missingMappings = findMissingMappings(input.components, input.mappings);
  const warnings: string[] = [];
  const errors: string[] = [];

  const laborSummaryBase = summarizeLaborAllocations(input.laborAllocations ?? []);
  if (Math.abs(laborSummaryBase.totalGross - totals.grossWages) > 0.05) {
    warnings.push(
      `Labor allocation gross ${laborSummaryBase.totalGross.toFixed(2)} differs from payroll gross ${totals.grossWages.toFixed(2)}`,
    );
  }

  const burdenRows = allocateEmployerBurden({
    totalEmployerBurden: totals.employerTaxes,
    destinations: (input.laborAllocations ?? []).map((row, index) => ({
      key: `${row.workerId}:${row.jobId ?? "none"}:${row.laborType}:${index}`,
      jobId: row.jobId ?? null,
      laborType: row.laborType,
      grossAmount: row.grossAmount,
    })),
  });

  const laborJobLines: PayrollJournalLine[] = [];
  // Job-cost dimensions are informational on wage expense lines when direct labor is allocated.
  for (const row of input.laborAllocations ?? []) {
    if (!row.jobId || row.laborType !== "direct") continue;
    // Dimensions attach to recognition via memo metadata; aggregate journal uses mapping accounts.
    laborJobLines.push({
      accountId: input.wageExpenseAccountId,
      debit: 0,
      credit: 0,
      memo: `Labor allocation ${row.workerId} job ${row.jobId}`,
      jobId: row.jobId,
      costClassification: costClassificationForLaborType(row.laborType),
    });
  }

  const journalLines = buildPayrollRecognitionJournalLines({
    components: input.components,
    mappings: input.mappings,
  });

  const totalDebits = sumJournalDebits(journalLines);
  const totalCredits = sumJournalCredits(journalLines);
  const balanced = Math.abs(totalDebits - totalCredits) <= 0.009;

  if (!balanced) errors.push("Payroll journal is unbalanced");
  if (missingMappings.length) {
    errors.push(`Missing account mappings: ${missingMappings.join(", ")}`);
  }

  const assignedBurden = roundMoney(burdenRows.reduce((sum, row) => sum + row.burdenAmount, 0));

  return {
    ...totals,
    totalDebits,
    totalCredits,
    balanced,
    missingMappings,
    warnings,
    errors,
    journalLines,
    laborSummary: {
      assignedGross: laborSummaryBase.directGross + laborSummaryBase.indirectGross,
      unassignedGross: laborSummaryBase.unallocatedGross,
      assignedBurden,
      unassignedBurden: roundMoney(totals.employerTaxes - assignedBurden),
    },
  };
}

export function validatePayrollImport(input: CanonicalPayrollImport): string[] {
  const errors: string[] = [];
  if (!input.externalRunId.trim()) errors.push("externalRunId is required");
  if (!input.payDate.trim()) errors.push("payDate is required");
  if (!input.components.length) errors.push("At least one payroll component is required");
  for (const row of input.components) {
    if (row.amount < 0) errors.push(`Negative amount for ${row.category}`);
  }
  return errors;
}

export function assertSameOrganizationForPayroll(input: {
  organizationId: string;
  workerOrgId: string;
  jobOrgId?: string | null;
}): void {
  validateLaborAllocationOrgScope(input);
}
