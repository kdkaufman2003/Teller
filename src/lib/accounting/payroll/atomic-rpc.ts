import type { SupabaseClient } from "@supabase/supabase-js";
import type { JournalLineInput } from "../post";

export type PayrollSimulateFailureAfter = "before_journal" | "after_journal";

function journalLinesPayload(lines: JournalLineInput[]) {
  return lines.map((line) => ({
    account_id: line.account_id,
    debit: line.debit ?? 0,
    credit: line.credit ?? 0,
    party_id: line.party_id ?? null,
    job_id: line.job_id ?? null,
    job_cost_category_id: line.job_cost_category_id ?? null,
    cost_classification: line.cost_classification ?? "",
    fixed_asset_id: line.fixed_asset_id ?? null,
    memo: line.memo ?? "",
  }));
}

type AtomicPostPayrollResult = {
  duplicate: boolean;
  recovered?: boolean;
  payrollRunId: string;
  journalEntryId: string;
};

type AtomicReversePayrollResult = {
  duplicate: boolean;
  recovered?: boolean;
  payrollRunId: string;
  reversalJournalEntryId: string;
};

type AtomicSettlementResult = {
  duplicate: boolean;
  recovered?: boolean;
  settlementId: string;
  journalEntryId: string;
};

function mapAtomicRow(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

export async function atomicPostPayrollRunJournal(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    payrollRunId: string;
    entryDate: string;
    memo: string;
    lines: JournalLineInput[];
    actorId?: string | null;
    simulateFailureAfter?: PayrollSimulateFailureAfter | null;
  },
): Promise<AtomicPostPayrollResult> {
  if (input.simulateFailureAfter === "before_journal") {
    throw new Error("Simulated failure before payroll journal creation");
  }

  const { data, error } = await supabase.rpc("teller_atomic_post_payroll_run", {
    p_organization_id: input.organizationId,
    p_payroll_run_id: input.payrollRunId,
    p_entry_date: input.entryDate,
    p_memo: input.memo,
    p_lines: journalLinesPayload(input.lines),
    p_actor_id: input.actorId ?? null,
    p_simulate_failure_after: null,
  });
  if (error) throw new Error(error.message);
  const row = mapAtomicRow(data);
  const result = {
    duplicate: Boolean(row.duplicate),
    recovered: row.recovered != null ? Boolean(row.recovered) : undefined,
    payrollRunId: String(row.payroll_run_id),
    journalEntryId: String(row.journal_entry_id),
  };

  if (input.simulateFailureAfter === "after_journal") {
    throw new Error("Simulated failure after payroll journal creation");
  }

  return result;
}

export async function atomicReversePayrollRunJournal(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    payrollRunId: string;
    reversalDate: string;
    memo: string;
    lines: JournalLineInput[];
    actorId?: string | null;
    simulateFailureAfter?: PayrollSimulateFailureAfter | null;
  },
): Promise<AtomicReversePayrollResult> {
  if (input.simulateFailureAfter === "before_journal") {
    throw new Error("Simulated failure before payroll reversal journal creation");
  }

  const { data, error } = await supabase.rpc("teller_atomic_reverse_payroll_run", {
    p_organization_id: input.organizationId,
    p_payroll_run_id: input.payrollRunId,
    p_reversal_date: input.reversalDate,
    p_memo: input.memo,
    p_lines: journalLinesPayload(input.lines),
    p_actor_id: input.actorId ?? null,
    p_simulate_failure_after: null,
  });
  if (error) throw new Error(error.message);
  const row = mapAtomicRow(data);
  const result = {
    duplicate: Boolean(row.duplicate),
    recovered: row.recovered != null ? Boolean(row.recovered) : undefined,
    payrollRunId: String(row.payroll_run_id),
    reversalJournalEntryId: String(row.reversal_journal_entry_id),
  };

  if (input.simulateFailureAfter === "after_journal") {
    throw new Error("Simulated failure after payroll reversal journal creation");
  }

  return result;
}

export async function atomicPostPayrollSettlementJournal(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    settlementId: string;
    entryDate: string;
    memo: string;
    lines: JournalLineInput[];
    actorId?: string | null;
    simulateFailureAfter?: PayrollSimulateFailureAfter | null;
  },
): Promise<AtomicSettlementResult> {
  if (input.simulateFailureAfter === "before_journal") {
    throw new Error("Simulated failure before payroll settlement journal creation");
  }

  const { data, error } = await supabase.rpc("teller_atomic_post_payroll_settlement", {
    p_organization_id: input.organizationId,
    p_settlement_id: input.settlementId,
    p_entry_date: input.entryDate,
    p_memo: input.memo,
    p_lines: journalLinesPayload(input.lines),
    p_actor_id: input.actorId ?? null,
    p_simulate_failure_after: null,
  });
  if (error) throw new Error(error.message);
  const row = mapAtomicRow(data);
  const result = {
    duplicate: Boolean(row.duplicate),
    recovered: row.recovered != null ? Boolean(row.recovered) : undefined,
    settlementId: String(row.settlement_id),
    journalEntryId: String(row.journal_entry_id),
  };

  if (input.simulateFailureAfter === "after_journal") {
    throw new Error("Simulated failure after payroll settlement journal creation");
  }

  return result;
}

export async function payrollAtomicRpcAvailable(supabase: SupabaseClient): Promise<boolean> {
  const { error } = await supabase.rpc("teller_atomic_post_payroll_run", {
    p_organization_id: "00000000-0000-0000-0000-000000000000",
    p_payroll_run_id: "00000000-0000-0000-0000-000000000000",
    p_entry_date: "2099-01-01",
    p_memo: "probe",
    p_lines: [],
    p_actor_id: null,
    p_simulate_failure_after: null,
  });
  if (!error) return true;
  const message = error.message ?? String(error);
  if (/function.*does not exist/i.test(message)) return false;
  if (/schema cache/i.test(message)) return false;
  if (/could not find the function/i.test(message)) return false;
  return true;
}
