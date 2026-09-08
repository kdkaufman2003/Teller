import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent } from "../audit";
import { assertOrgPeriodOpen } from "../post";
import { assertHfacPayrollHardRefusal } from "./hfac-boundary";
import {
  assertPayrollJournalBalanced,
  buildPayrollRecognitionJournalLines,
  buildPayrollReversalLines,
  computePayrollTotals,
} from "./journal-lines";
import { previewPayrollRun, validatePayrollImport } from "./import-normalizer";
import {
  atomicPostPayrollRunJournal,
  atomicReversePayrollRunJournal,
  type PayrollSimulateFailureAfter,
} from "./atomic-rpc";
import {
  payrollRunIdempotencyKey,
  type CanonicalPayrollImport,
  type PayrollAccountMapping,
  type PayrollComponentInput,
} from "./types";

async function findPostedPayrollRun(
  supabase: SupabaseClient,
  organizationId: string,
  idempotencyKey: string,
): Promise<{ payrollRunId: string; journalEntryId: string } | null> {
  const { data } = await supabase
    .from("teller_payroll_runs")
    .select("id, status, journal_entry_id")
    .eq("organization_id", organizationId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (data?.journal_entry_id && data.status === "posted") {
    return { payrollRunId: data.id as string, journalEntryId: data.journal_entry_id as string };
  }
  return null;
}

async function upsertPayrollRunRow(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    provider: string;
    externalRunId: string;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    idempotencyKey: string;
    totals: ReturnType<typeof computePayrollTotals>;
  },
): Promise<string> {
  const payload = {
    organization_id: input.organizationId,
    provider: input.provider,
    external_run_id: input.externalRunId,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    pay_date: input.payDate,
    status: "reviewed",
    gross_wages: input.totals.grossWages,
    employee_taxes: input.totals.employeeTaxes,
    employee_deductions: input.totals.employeeDeductions,
    employer_taxes: input.totals.employerTaxes,
    net_pay: input.totals.netPay,
    total_liability: input.totals.totalLiability,
    idempotency_key: input.idempotencyKey,
  };

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { data, error } = await supabase
      .from("teller_payroll_runs")
      .upsert(payload, { onConflict: "organization_id,idempotency_key" })
      .select("id")
      .maybeSingle();
    if (data?.id) return data.id as string;

    const { data: existing } = await supabase
      .from("teller_payroll_runs")
      .select("id")
      .eq("organization_id", input.organizationId)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (existing?.id) return existing.id as string;

    if (error && attempt === 5) throw new Error(error.message);
    await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
  }

  throw new Error("Could not create payroll run");
}

export async function postPayrollRun(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    provider: string;
    externalRunId: string;
    payDate: string;
    periodStart: string;
    periodEnd: string;
    components: PayrollComponentInput[];
    mappings: PayrollAccountMapping[];
    wageExpenseAccountId: string;
    employerTaxExpenseAccountId: string;
    actorId?: string | null;
    operationId?: string;
    simulateFailureAfter?: PayrollSimulateFailureAfter | null;
  },
): Promise<{ payrollRunId: string; journalEntryId: string }> {
  assertHfacPayrollHardRefusal(input.organizationId);
  await assertOrgPeriodOpen(supabase, input.organizationId, input.payDate);

  const idempotencyKey =
    input.operationId ?? payrollRunIdempotencyKey(input.provider, input.externalRunId);

  const existingPosted = await findPostedPayrollRun(supabase, input.organizationId, idempotencyKey);
  if (existingPosted) return existingPosted;

  const preview = previewPayrollRun({
    components: input.components,
    mappings: input.mappings,
    wageExpenseAccountId: input.wageExpenseAccountId,
    employerTaxExpenseAccountId: input.employerTaxExpenseAccountId,
  });
  if (preview.errors.length) {
    throw new Error(preview.errors.join("; "));
  }

  const journalLines = buildPayrollRecognitionJournalLines({
    components: input.components,
    mappings: input.mappings,
  }).map((row) => ({
    account_id: row.accountId,
    debit: row.debit,
    credit: row.credit,
    memo: row.memo,
    job_id: row.jobId ?? null,
    cost_classification: row.costClassification ?? "",
  }));

  assertPayrollJournalBalanced(
    journalLines.map((row) => ({
      accountId: row.account_id,
      debit: row.debit ?? 0,
      credit: row.credit ?? 0,
      memo: row.memo ?? "",
    })),
  );

  const totals = computePayrollTotals(input.components);

  const payrollRunId = await upsertPayrollRunRow(supabase, {
    organizationId: input.organizationId,
    provider: input.provider,
    externalRunId: input.externalRunId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    payDate: input.payDate,
    idempotencyKey,
    totals,
  });

  const posted = await atomicPostPayrollRunJournal(supabase, {
    organizationId: input.organizationId,
    payrollRunId,
    entryDate: input.payDate,
    memo: `Payroll run ${input.externalRunId}`,
    lines: journalLines,
    actorId: input.actorId,
    simulateFailureAfter: input.simulateFailureAfter ?? null,
  });

  if (!posted.duplicate) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "payroll.run.posted",
      resourceKind: "payroll_run",
      resourceId: payrollRunId,
      metadata: {
        provider: input.provider,
        externalRunId: input.externalRunId,
        journalEntryId: posted.journalEntryId,
      },
    });
  }

  return { payrollRunId: posted.payrollRunId, journalEntryId: posted.journalEntryId };
}

export async function reversePayrollRun(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    payrollRunId: string;
    reversalDate: string;
    mappings: PayrollAccountMapping[];
    components: PayrollComponentInput[];
    actorId?: string | null;
    simulateFailureAfter?: PayrollSimulateFailureAfter | null;
  },
): Promise<{ reversalJournalEntryId: string }> {
  assertHfacPayrollHardRefusal(input.organizationId);
  await assertOrgPeriodOpen(supabase, input.organizationId, input.reversalDate);

  const { data: run, error } = await supabase
    .from("teller_payroll_runs")
    .select("id, status, journal_entry_id, reversal_journal_entry_id, organization_id")
    .eq("id", input.payrollRunId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!run) throw new Error("Payroll run not found");
  if (run.status === "reversed" || run.reversal_journal_entry_id) {
    throw new Error("Payroll run already reversed");
  }
  if (run.status !== "posted" || !run.journal_entry_id) {
    throw new Error("Only posted payroll runs can be reversed");
  }

  const { data: lines, error: linesError } = await supabase
    .from("teller_journal_lines")
    .select("account_id, debit, credit, party_id, job_id, fixed_asset_id, memo")
    .eq("entry_id", run.journal_entry_id as string);
  if (linesError) throw new Error(linesError.message);
  if (!lines?.length) throw new Error("Cannot reverse payroll run with no journal lines");

  const reversalLines = buildPayrollReversalLines(
    (lines ?? []).map((row) => ({
      accountId: row.account_id as string,
      debit: Number(row.debit ?? 0),
      credit: Number(row.credit ?? 0),
      memo: row.memo ?? "",
      jobId: row.job_id ?? null,
    })),
  ).map((row) => ({
    account_id: row.accountId,
    debit: row.debit,
    credit: row.credit,
    memo: row.memo,
    job_id: row.jobId ?? null,
    cost_classification: "",
  }));

  const reversed = await atomicReversePayrollRunJournal(supabase, {
    organizationId: input.organizationId,
    payrollRunId: input.payrollRunId,
    reversalDate: input.reversalDate,
    memo: `Reverse payroll run ${input.payrollRunId}`,
    lines: reversalLines,
    actorId: input.actorId,
    simulateFailureAfter: input.simulateFailureAfter ?? null,
  });

  if (!reversed.duplicate) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "payroll.run.reversed",
      resourceKind: "payroll_run",
      resourceId: input.payrollRunId,
      metadata: { reversalJournalEntryId: reversed.reversalJournalEntryId },
    });
  }

  return { reversalJournalEntryId: reversed.reversalJournalEntryId };
}

export function importCanonicalPayroll(payload: CanonicalPayrollImport) {
  const errors = validatePayrollImport(payload);
  if (errors.length) throw new Error(errors.join("; "));
  return payload;
}
