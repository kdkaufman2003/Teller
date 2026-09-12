import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { consolidationAccountKey, isIntercompanyAccount } from "../grouping";
import { roundMoney } from "../../payment-fees";
import type { ConsolidationScopeEntity } from "../types";
import type { EliminationLineInput, IntercompanyPlEliminationSuggestion } from "./types";

type PlSide = {
  accountId: string;
  type: string;
  subtype: string;
  code: string;
  name: string;
  amount: number;
  legalEntityId: string;
};

async function plSidesFromJournal(
  supabase: SupabaseClient,
  organizationId: string,
  entryId: string,
  legalEntityId: string,
): Promise<PlSide[]> {
  const { data: lines, error: lineError } = await supabase
    .from("teller_journal_lines")
    .select("account_id, debit, credit")
    .eq("entry_id", entryId);
  if (lineError) throw new Error(lineError.message);
  const accountIds = (lines ?? []).map((line) => line.account_id as string);
  if (!accountIds.length) return [];

  const { data: accounts, error: accountError } = await supabase
    .from("teller_accounts")
    .select("id, type, subtype, code, name")
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", legalEntityId)
    .in("id", accountIds);
  if (accountError) throw new Error(accountError.message);

  const accountMap = new Map((accounts ?? []).map((row) => [row.id as string, row]));
  const sides: PlSide[] = [];

  for (const line of lines ?? []) {
    const account = accountMap.get(line.account_id as string);
    if (!account) continue;
    if (isIntercompanyAccount({ subtype: account.subtype as string })) continue;
    if (!["revenue", "cogs", "expense"].includes(account.type as string)) continue;

    const debit = asNumber(line.debit);
    const credit = asNumber(line.credit);
    const amount =
      account.type === "revenue"
        ? roundMoney(credit - debit)
        : roundMoney(debit - credit);
    if (Math.abs(amount) < 0.005) continue;

    sides.push({
      accountId: account.id as string,
      type: account.type as string,
      subtype: (account.subtype as string) ?? "",
      code: account.code as string,
      name: account.name as string,
      amount,
      legalEntityId,
    });
  }

  return sides;
}

export async function suggestIntercompanyPlEliminations(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    entities: ConsolidationScopeEntity[];
    periodStart: string;
    periodEnd: string;
  },
): Promise<IntercompanyPlEliminationSuggestion[]> {
  const entitySet = new Set(input.entities.map((entity) => entity.legalEntityId));
  const periodStart = input.periodStart.slice(0, 10);
  const periodEnd = input.periodEnd.slice(0, 10);

  const { data: transactions, error } = await supabase
    .from("teller_intercompany_transactions")
    .select(
      "id, source_legal_entity_id, counterparty_legal_entity_id, amount, description, transaction_date, status, source_journal_id, counterparty_journal_id, transaction_type",
    )
    .eq("organization_id", input.organizationId)
    .eq("status", "posted")
    .gte("transaction_date", periodStart)
    .lte("transaction_date", periodEnd);
  if (error) throw new Error(error.message);

  const suggestions: IntercompanyPlEliminationSuggestion[] = [];

  for (const tx of transactions ?? []) {
    const sourceId = tx.source_legal_entity_id as string;
    const counterpartyId = tx.counterparty_legal_entity_id as string;
    if (!entitySet.has(sourceId) || !entitySet.has(counterpartyId)) continue;
    if (!tx.source_journal_id || !tx.counterparty_journal_id) continue;

    const sourceSides = await plSidesFromJournal(
      supabase,
      input.organizationId,
      tx.source_journal_id as string,
      sourceId,
    );
    const counterpartySides = await plSidesFromJournal(
      supabase,
      input.organizationId,
      tx.counterparty_journal_id as string,
      counterpartyId,
    );
    if (!sourceSides.length && !counterpartySides.length) continue;

    const allSides = [...sourceSides, ...counterpartySides];
    const revenueSide = allSides.find((side) => side.type === "revenue");
    const expenseSide = allSides.find((side) => side.type === "expense" || side.type === "cogs");
    if (!revenueSide || !expenseSide) continue;

    const amount = roundMoney(Math.min(Math.abs(revenueSide.amount), Math.abs(expenseSide.amount)));
    if (amount < 0.005) continue;

    const proposedLines: EliminationLineInput[] = [
      {
        groupKey: consolidationAccountKey(revenueSide),
        accountType: revenueSide.type,
        accountSubtype: revenueSide.subtype,
        accountCode: revenueSide.code,
        accountName: revenueSide.name,
        sourceLegalEntityId: revenueSide.legalEntityId,
        sourceAccountId: revenueSide.accountId,
        debit: amount,
      },
      {
        groupKey: consolidationAccountKey(expenseSide),
        accountType: expenseSide.type,
        accountSubtype: expenseSide.subtype,
        accountCode: expenseSide.code,
        accountName: expenseSide.name,
        sourceLegalEntityId: expenseSide.legalEntityId,
        sourceAccountId: expenseSide.accountId,
        credit: amount,
      },
    ];

    suggestions.push({
      intercompanyTransactionId: tx.id as string,
      entityAId: sourceId,
      entityBId: counterpartyId,
      amount,
      description: (tx.description as string) ?? "Intercompany P&L elimination",
      proposedLines,
      sources: [
        {
          sourceKind: "intercompany_transaction",
          sourceId: tx.id as string,
          metadata: {
            transactionType: tx.transaction_type,
            transactionDate: tx.transaction_date,
            sourceJournalId: tx.source_journal_id,
            counterpartyJournalId: tx.counterparty_journal_id,
          },
        },
      ],
    });
  }

  return suggestions;
}
