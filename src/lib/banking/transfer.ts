import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { normalizeBankingEventId } from "./categorize";
import { recordBankingAuditEvent } from "./audit";
import type { TransferPairCandidate } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENCY_TOLERANCE = 0.01;

type TransferCandidateRow = {
  id: string;
  bank_account_id: string;
  posted_date: string;
  normalized_amount: number;
  description?: string;
  name?: string;
  status?: string;
};

function daysApart(a: string, b: string): number {
  const left = new Date(a.slice(0, 10)).getTime();
  const right = new Date(b.slice(0, 10)).getTime();
  return Math.abs(left - right) / DAY_MS;
}

/** Detect opposite-sign transfer pairs across bank accounts within date window. */
export function detectTransferPairs(
  transactions: TransferCandidateRow[],
  options?: { maxDaysApart?: number },
): TransferPairCandidate[] {
  const maxDays = options?.maxDaysApart ?? 3;
  const active = transactions.filter(
    (txn) =>
      txn.status !== "excluded" &&
      txn.status !== "reconciled" &&
      Math.abs(asNumber(txn.normalized_amount)) > CURRENCY_TOLERANCE,
  );

  const pairs: TransferPairCandidate[] = [];
  const used = new Set<string>();

  for (let i = 0; i < active.length; i += 1) {
    const source = active[i];
    if (used.has(source.id)) continue;
    const sourceAmount = asNumber(source.normalized_amount);

    for (let j = i + 1; j < active.length; j += 1) {
      const destination = active[j];
      if (used.has(destination.id)) continue;
      if (source.bank_account_id === destination.bank_account_id) continue;

      const destinationAmount = asNumber(destination.normalized_amount);
      if (sourceAmount === 0 || destinationAmount === 0) continue;
      if (Math.sign(sourceAmount) === Math.sign(destinationAmount)) continue;

      const amount = Math.min(Math.abs(sourceAmount), Math.abs(destinationAmount));
      if (Math.abs(Math.abs(sourceAmount) - Math.abs(destinationAmount)) > CURRENCY_TOLERANCE) {
        continue;
      }

      const apart = daysApart(source.posted_date, destination.posted_date);
      if (apart > maxDays) continue;

      const outflow =
        sourceAmount < 0
          ? source
          : destinationAmount < 0
            ? destination
            : null;
      const inflow =
        sourceAmount > 0
          ? source
          : destinationAmount > 0
            ? destination
            : null;
      if (!outflow || !inflow) continue;

      pairs.push({
        sourceTransactionId: outflow.id,
        destinationTransactionId: inflow.id,
        amount,
        transferDate: outflow.posted_date >= inflow.posted_date ? outflow.posted_date : inflow.posted_date,
        confidence: apart <= 1 ? 0.95 : 0.75,
        reason:
          apart <= 1
            ? "Opposite amounts on linked accounts within one day"
            : "Opposite amounts on linked accounts within transfer window",
      });
      used.add(outflow.id);
      used.add(inflow.id);
      break;
    }
  }

  return pairs.sort((a, b) => b.confidence - a.confidence);
}

export async function assertSameEntityBankTransfer(
  supabase: SupabaseClient,
  organizationId: string,
  sourceBankTransactionId: string,
  destinationBankTransactionId: string,
): Promise<void> {
  const { data: txns, error: txnError } = await supabase
    .from("teller_bank_transactions")
    .select("id, bank_account_id")
    .eq("organization_id", organizationId)
    .in("id", [sourceBankTransactionId, destinationBankTransactionId]);
  if (txnError) throw new Error(txnError.message);
  if ((txns ?? []).length !== 2) {
    throw new Error("Both bank transactions must belong to your organization");
  }

  const accountIds = [...new Set((txns ?? []).map((row) => row.bank_account_id as string))];
  const { data: accounts, error: accountError } = await supabase
    .from("teller_bank_accounts")
    .select("id, legal_entity_id")
    .eq("organization_id", organizationId)
    .in("id", accountIds);
  if (accountError) throw new Error(accountError.message);

  const entities = new Set((accounts ?? []).map((row) => row.legal_entity_id as string));
  if (entities.size > 1) {
    throw new Error(
      "Transfers between different companies must use Intercompany under Accounting — not bank transfer.",
    );
  }
}

export async function createBankTransfer(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    sourceBankTransactionId: string;
    destinationBankTransactionId: string;
    amount: number;
    transferDate: string;
    idempotencyEventId?: string | null;
    actorId?: string | null;
  },
): Promise<{ duplicate: boolean; transferId?: string; journalEntryId?: string }> {
  await assertSameEntityBankTransfer(
    supabase,
    input.organizationId,
    input.sourceBankTransactionId,
    input.destinationBankTransactionId,
  );

  const eventId = normalizeBankingEventId(input.idempotencyEventId);
  const { data, error } = await supabase.rpc("teller_create_bank_transfer", {
    p_organization_id: input.organizationId,
    p_source_bank_transaction_id: input.sourceBankTransactionId,
    p_destination_bank_transaction_id: input.destinationBankTransactionId,
    p_amount: asNumber(input.amount),
    p_transfer_date: input.transferDate,
    p_idempotency_event_id: eventId,
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error(error.message);

  const row = (data ?? {}) as Record<string, unknown>;
  const duplicate = Boolean(row.duplicate);
  if (!duplicate) {
    await recordBankingAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      action: "banking.transfer.created",
      resourceKind: "bank_transfer",
      resourceId: row.transfer_id as string | undefined,
      metadata: {
        sourceBankTransactionId: input.sourceBankTransactionId,
        destinationBankTransactionId: input.destinationBankTransactionId,
        amount: input.amount,
        journalEntryId: row.journal_entry_id,
      },
    });
  }

  return {
    duplicate,
    transferId: row.transfer_id as string | undefined,
    journalEntryId: row.journal_entry_id as string | undefined,
  };
}

export async function suggestTransferPairsForOrg(
  supabase: SupabaseClient,
  organizationId: string,
  bankAccountId?: string | null,
): Promise<TransferPairCandidate[]> {
  let query = supabase
    .from("teller_bank_transactions")
    .select("id, bank_account_id, posted_date, normalized_amount, description, name, status")
    .eq("organization_id", organizationId)
    .in("status", ["unreviewed", "suggested", "partially_matched"]);

  if (bankAccountId) {
    query = query.eq("bank_account_id", bankAccountId);
  }

  const { data, error } = await query.limit(500);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as TransferCandidateRow[];
  const accountIds = [...new Set(rows.map((row) => row.bank_account_id))];
  const entityByAccount = new Map<string, string>();
  if (accountIds.length) {
    const { data: accounts, error: accountError } = await supabase
      .from("teller_bank_accounts")
      .select("id, legal_entity_id")
      .eq("organization_id", organizationId)
      .in("id", accountIds);
    if (accountError) throw new Error(accountError.message);
    for (const account of accounts ?? []) {
      entityByAccount.set(account.id as string, account.legal_entity_id as string);
    }
  }

  const pairs = detectTransferPairs(rows);
  return pairs.map((pair) => {
    const sourceTxn = rows.find((row) => row.id === pair.sourceTransactionId);
    const destTxn = rows.find((row) => row.id === pair.destinationTransactionId);
    const sourceEntity = sourceTxn ? entityByAccount.get(sourceTxn.bank_account_id) : undefined;
    const destEntity = destTxn ? entityByAccount.get(destTxn.bank_account_id) : undefined;
    const crossEntity = Boolean(
      sourceEntity && destEntity && sourceEntity !== destEntity,
    );
    return {
      ...pair,
      crossEntity,
      reason: crossEntity
        ? "Different companies — use Intercompany instead of bank transfer"
        : pair.reason,
    };
  });
}
