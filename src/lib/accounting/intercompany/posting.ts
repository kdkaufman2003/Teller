import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { recordAuditEvent } from "../audit";
import { assertBalanced, type JournalLineInput } from "../post";
import { provisionIntercompanyAccounts } from "./accounts";
import type {
  CashReceivedOnBehalfInput,
  ExpenseOnBehalfInput,
  FundTransferInput,
  PostIntercompanyInput,
} from "./types";
import {
  assertIntercompanyAccess,
  assertIntercompanyEntityPair,
  assertIntercompanyLineAccounts,
} from "./validation";

function linesPayload(
  lines: Array<{ accountId: string; debit?: number; credit?: number; memo?: string }>,
): JournalLineInput[] {
  return lines.map((line) => ({
    account_id: line.accountId,
    debit: asNumber(line.debit),
    credit: asNumber(line.credit),
    memo: line.memo,
  }));
}

function rpcLinesPayload(lines: JournalLineInput[]) {
  return lines.map((line) => ({
    account_id: line.account_id,
    debit: asNumber(line.debit),
    credit: asNumber(line.credit),
    party_id: null,
    job_id: null,
    job_cost_category_id: null,
    cost_classification: "",
    fixed_asset_id: null,
    memo: line.memo ?? "",
  }));
}

export async function postIntercompanyTransaction(
  supabase: SupabaseClient,
  input: PostIntercompanyInput & {
    auth?: { userId: string; role: import("@/types").ProfileRole };
  },
) {
  await assertIntercompanyEntityPair(supabase, {
    organizationId: input.organizationId,
    sourceLegalEntityId: input.sourceLegalEntityId,
    counterpartyLegalEntityId: input.counterpartyLegalEntityId,
  });

  if (input.auth) {
    await assertIntercompanyAccess(supabase, {
      organizationId: input.organizationId,
      sourceLegalEntityId: input.sourceLegalEntityId,
      counterpartyLegalEntityId: input.counterpartyLegalEntityId,
      auth: input.auth,
    });
  }

  const sourceLines = linesPayload(input.sourceLines);
  const counterpartyLines = linesPayload(input.counterpartyLines);
  assertBalanced(sourceLines);
  assertBalanced(counterpartyLines);

  await assertIntercompanyLineAccounts(supabase, {
    organizationId: input.organizationId,
    legalEntityId: input.sourceLegalEntityId,
    accountIds: sourceLines.map((l) => l.account_id),
  });
  await assertIntercompanyLineAccounts(supabase, {
    organizationId: input.organizationId,
    legalEntityId: input.counterpartyLegalEntityId,
    accountIds: counterpartyLines.map((l) => l.account_id),
  });

  const { data, error } = await supabase.rpc("teller_atomic_post_intercompany", {
    p_organization_id: input.organizationId,
    p_source_legal_entity_id: input.sourceLegalEntityId,
    p_counterparty_legal_entity_id: input.counterpartyLegalEntityId,
    p_transaction_type: input.transactionType,
    p_entry_date: input.entryDate,
    p_amount: input.amount,
    p_description: input.description,
    p_reference: input.reference ?? null,
    p_source_lines: rpcLinesPayload(sourceLines),
    p_counterparty_lines: rpcLinesPayload(counterpartyLines),
    p_idempotency_key: input.idempotencyKey ?? null,
    p_external_event_id: null,
    p_metadata: {},
    p_actor_id: input.actorId ?? null,
    p_simulate_failure_after: null,
  });

  if (error) throw new Error(error.message);

  const result = data as {
    duplicate: boolean;
    intercompany_transaction_id: string;
    source_journal_id: string;
    counterparty_journal_id: string;
  };

  if (!result.duplicate) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "intercompany.posted",
      resourceKind: "intercompany_transaction",
      resourceId: result.intercompany_transaction_id,
      metadata: {
        transactionType: input.transactionType,
        sourceLegalEntityId: input.sourceLegalEntityId,
        counterpartyLegalEntityId: input.counterpartyLegalEntityId,
        amount: input.amount,
        sourceJournalId: result.source_journal_id,
        counterpartyJournalId: result.counterparty_journal_id,
      },
    });
  }

  return {
    duplicate: result.duplicate,
    intercompanyTransactionId: result.intercompany_transaction_id,
    sourceJournalId: result.source_journal_id,
    counterpartyJournalId: result.counterparty_journal_id,
  };
}

export async function postExpenseOnBehalf(
  supabase: SupabaseClient,
  input: ExpenseOnBehalfInput & {
    auth?: { userId: string; role: import("@/types").ProfileRole };
  },
) {
  const sourceAccounts = await provisionIntercompanyAccounts(supabase, {
    organizationId: input.organizationId,
    ownerLegalEntityId: input.sourceLegalEntityId,
    counterpartyLegalEntityId: input.counterpartyLegalEntityId,
  });
  const counterpartyAccounts = await provisionIntercompanyAccounts(supabase, {
    organizationId: input.organizationId,
    ownerLegalEntityId: input.counterpartyLegalEntityId,
    counterpartyLegalEntityId: input.sourceLegalEntityId,
  });

  return postIntercompanyTransaction(supabase, {
    organizationId: input.organizationId,
    sourceLegalEntityId: input.sourceLegalEntityId,
    counterpartyLegalEntityId: input.counterpartyLegalEntityId,
    transactionType: "expense_on_behalf",
    entryDate: input.entryDate,
    amount: input.amount,
    description: input.description,
    sourceLines: [
      { accountId: sourceAccounts.dueFromAccountId, debit: input.amount },
      { accountId: input.sourcePaymentAccountId, credit: input.amount },
    ],
    counterpartyLines: [
      { accountId: input.counterpartyExpenseAccountId, debit: input.amount },
      { accountId: counterpartyAccounts.dueToAccountId, credit: input.amount },
    ],
    idempotencyKey: input.idempotencyKey,
    actorId: input.actorId,
    auth: input.auth,
  });
}

export async function postCashReceivedOnBehalf(
  supabase: SupabaseClient,
  input: CashReceivedOnBehalfInput & {
    auth?: { userId: string; role: import("@/types").ProfileRole };
  },
) {
  const sourceAccounts = await provisionIntercompanyAccounts(supabase, {
    organizationId: input.organizationId,
    ownerLegalEntityId: input.sourceLegalEntityId,
    counterpartyLegalEntityId: input.counterpartyLegalEntityId,
  });
  const counterpartyAccounts = await provisionIntercompanyAccounts(supabase, {
    organizationId: input.organizationId,
    ownerLegalEntityId: input.counterpartyLegalEntityId,
    counterpartyLegalEntityId: input.sourceLegalEntityId,
  });

  return postIntercompanyTransaction(supabase, {
    organizationId: input.organizationId,
    sourceLegalEntityId: input.sourceLegalEntityId,
    counterpartyLegalEntityId: input.counterpartyLegalEntityId,
    transactionType: "cash_received_on_behalf",
    entryDate: input.entryDate,
    amount: input.amount,
    description: input.description,
    sourceLines: [
      { accountId: input.sourceCashAccountId, debit: input.amount },
      { accountId: sourceAccounts.dueToAccountId, credit: input.amount },
    ],
    counterpartyLines: [
      { accountId: counterpartyAccounts.dueFromAccountId, debit: input.amount },
      { accountId: input.counterpartyCreditAccountId, credit: input.amount },
    ],
    idempotencyKey: input.idempotencyKey,
    actorId: input.actorId,
    auth: input.auth,
  });
}

export async function postIntercompanyFundTransfer(
  supabase: SupabaseClient,
  input: FundTransferInput & {
    auth?: { userId: string; role: import("@/types").ProfileRole };
  },
) {
  const sourceAccounts = await provisionIntercompanyAccounts(supabase, {
    organizationId: input.organizationId,
    ownerLegalEntityId: input.sourceLegalEntityId,
    counterpartyLegalEntityId: input.counterpartyLegalEntityId,
  });
  const counterpartyAccounts = await provisionIntercompanyAccounts(supabase, {
    organizationId: input.organizationId,
    ownerLegalEntityId: input.counterpartyLegalEntityId,
    counterpartyLegalEntityId: input.sourceLegalEntityId,
  });

  return postIntercompanyTransaction(supabase, {
    organizationId: input.organizationId,
    sourceLegalEntityId: input.sourceLegalEntityId,
    counterpartyLegalEntityId: input.counterpartyLegalEntityId,
    transactionType: "fund_transfer",
    entryDate: input.entryDate,
    amount: input.amount,
    description: input.description,
    sourceLines: [
      { accountId: sourceAccounts.dueFromAccountId, debit: input.amount },
      { accountId: input.sourceCashAccountId, credit: input.amount },
    ],
    counterpartyLines: [
      { accountId: input.counterpartyCashAccountId, debit: input.amount },
      { accountId: counterpartyAccounts.dueToAccountId, credit: input.amount },
    ],
    idempotencyKey: input.idempotencyKey,
    actorId: input.actorId,
    auth: input.auth,
  });
}
