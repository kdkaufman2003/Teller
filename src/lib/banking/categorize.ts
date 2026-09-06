import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import type { MatchedResourceType } from "./normalize";
import { recordBankingAuditEvent } from "./audit";
import type { BankSplitInput, CategorizeKind } from "./types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeBankingEventId(input?: string | null): string {
  if (input?.trim()) {
    const id = input.trim();
    if (!UUID_RE.test(id)) throw new Error("Event id must be a valid UUID.");
    return id;
  }
  return randomUUID();
}

export type BankingRpcResult = {
  duplicate: boolean;
  [key: string]: unknown;
};

function mapRpcRow(data: unknown): BankingRpcResult {
  const row = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return { ...row, duplicate: Boolean(row.duplicate) };
}

export async function confirmBankMatch(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    bankTransactionId: string;
    matchedResourceType: MatchedResourceType;
    matchedResourceId: string;
    matchedAmount: number;
    idempotencyEventId?: string | null;
    actorId?: string | null;
  },
): Promise<BankingRpcResult & { matchId?: string }> {
  const eventId = normalizeBankingEventId(input.idempotencyEventId);
  const { data, error } = await supabase.rpc("teller_confirm_bank_match", {
    p_organization_id: input.organizationId,
    p_bank_transaction_id: input.bankTransactionId,
    p_matched_resource_type: input.matchedResourceType,
    p_matched_resource_id: input.matchedResourceId,
    p_matched_amount: input.matchedAmount,
    p_idempotency_event_id: eventId,
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error(error.message);

  const row = mapRpcRow(data);
  if (!row.duplicate) {
    await recordBankingAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      action: "banking.match.confirmed",
      resourceKind: "bank_transaction",
      resourceId: input.bankTransactionId,
      metadata: {
        matchedResourceType: input.matchedResourceType,
        matchedResourceId: input.matchedResourceId,
        matchedAmount: input.matchedAmount,
        matchId: row.match_id,
      },
    });
  }

  return { ...row, matchId: row.match_id as string | undefined };
}

export async function removeBankMatch(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    matchId: string;
    reason: string;
    actorId?: string | null;
  },
): Promise<BankingRpcResult> {
  const { data, error } = await supabase.rpc("teller_remove_bank_match", {
    p_organization_id: input.organizationId,
    p_match_id: input.matchId,
    p_actor_id: input.actorId ?? null,
    p_reason: input.reason.trim(),
  });
  if (error) throw new Error(error.message);

  const row = mapRpcRow(data);
  if (!row.duplicate) {
    await recordBankingAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      action: "banking.match.removed",
      resourceKind: "bank_match",
      resourceId: input.matchId,
      metadata: { reason: input.reason.trim() },
    });
  }
  return row;
}

export async function excludeBankTransaction(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    bankTransactionId: string;
    actorId?: string | null;
  },
): Promise<BankingRpcResult> {
  const { data, error } = await supabase.rpc("teller_exclude_bank_transaction", {
    p_organization_id: input.organizationId,
    p_bank_transaction_id: input.bankTransactionId,
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error(error.message);

  const row = mapRpcRow(data);
  if (!row.duplicate) {
    await recordBankingAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      action: "banking.transaction.excluded",
      resourceKind: "bank_transaction",
      resourceId: input.bankTransactionId,
    });
  }
  return row;
}

export async function categorizeBankTransaction(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    bankTransactionId: string;
    categoryKind: CategorizeKind;
    accountId: string;
    partyId?: string | null;
    jobId?: string | null;
    memo?: string;
    idempotencyEventId?: string | null;
    actorId?: string | null;
  },
): Promise<BankingRpcResult & { journalEntryId?: string }> {
  const eventId = normalizeBankingEventId(input.idempotencyEventId);
  const { data, error } = await supabase.rpc("teller_categorize_bank_transaction", {
    p_organization_id: input.organizationId,
    p_bank_transaction_id: input.bankTransactionId,
    p_category_kind: input.categoryKind,
    p_account_id: input.accountId,
    p_party_id: input.partyId ?? null,
    p_job_id: input.jobId ?? null,
    p_memo: input.memo ?? "",
    p_idempotency_event_id: eventId,
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error(error.message);

  const row = mapRpcRow(data);
  if (!row.duplicate) {
    await recordBankingAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      action: "banking.transaction.categorized",
      resourceKind: "bank_transaction",
      resourceId: input.bankTransactionId,
      metadata: {
        categoryKind: input.categoryKind,
        accountId: input.accountId,
        journalEntryId: row.journal_entry_id,
      },
    });
  }

  return { ...row, journalEntryId: row.journal_entry_id as string | undefined };
}

export async function splitCategorizeBankTransaction(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    bankTransactionId: string;
    splits: BankSplitInput[];
    idempotencyEventId?: string | null;
    actorId?: string | null;
  },
): Promise<BankingRpcResult & { journalEntryId?: string }> {
  const eventId = normalizeBankingEventId(input.idempotencyEventId);
  const payload = input.splits.map((split) => ({
    account_id: split.accountId,
    amount: split.amount,
    party_id: split.partyId ?? null,
    job_id: split.jobId ?? null,
    memo: split.memo ?? "",
  }));

  const { data, error } = await supabase.rpc("teller_split_categorize_bank_transaction", {
    p_organization_id: input.organizationId,
    p_bank_transaction_id: input.bankTransactionId,
    p_splits: payload,
    p_idempotency_event_id: eventId,
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error(error.message);

  const row = mapRpcRow(data);
  if (!row.duplicate) {
    await recordBankingAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      action: "banking.transaction.split_categorized",
      resourceKind: "bank_transaction",
      resourceId: input.bankTransactionId,
      metadata: {
        splitCount: input.splits.length,
        journalEntryId: row.journal_entry_id,
      },
    });
  }

  return { ...row, journalEntryId: row.journal_entry_id as string | undefined };
}
