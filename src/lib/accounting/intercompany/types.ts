export type IntercompanyTransactionType =
  | "expense_on_behalf"
  | "cash_received_on_behalf"
  | "fund_transfer"
  | "manual";

export type IntercompanyStatus = "pending" | "posted" | "reversed";

export type IntercompanyTransactionRow = {
  id: string;
  organizationId: string;
  sourceLegalEntityId: string;
  counterpartyLegalEntityId: string;
  transactionType: IntercompanyTransactionType;
  transactionDate: string;
  description: string;
  reference: string | null;
  amount: number;
  currency: string;
  status: IntercompanyStatus;
  sourceJournalId: string | null;
  counterpartyJournalId: string | null;
  reversesTransactionId: string | null;
  reversalTransactionId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  reversedAt: string | null;
};

export type IntercompanyAccountPair = {
  dueFromAccountId: string;
  dueToAccountId: string;
  provisioned: boolean;
};

export type IntercompanyPairBalance = {
  entityAId: string;
  entityBId: string;
  aDueFromB: number;
  aDueToB: number;
  bDueFromA: number;
  bDueToA: number;
  receivablePayableDifference: number;
  payableReceivableDifference: number;
  balanced: boolean;
};

export type PostIntercompanyInput = {
  organizationId: string;
  sourceLegalEntityId: string;
  counterpartyLegalEntityId: string;
  transactionType: IntercompanyTransactionType;
  entryDate: string;
  amount: number;
  description: string;
  reference?: string | null;
  /** Source entity journal lines (must balance, entity-local accounts only). */
  sourceLines: Array<{
    accountId: string;
    debit?: number;
    credit?: number;
    memo?: string;
  }>;
  /** Counterparty entity journal lines (must balance, entity-local accounts only). */
  counterpartyLines: Array<{
    accountId: string;
    debit?: number;
    credit?: number;
    memo?: string;
  }>;
  idempotencyKey?: string | null;
  actorId?: string | null;
};

export type ExpenseOnBehalfInput = {
  organizationId: string;
  sourceLegalEntityId: string;
  counterpartyLegalEntityId: string;
  entryDate: string;
  amount: number;
  description: string;
  /** Source entity cash or AP account used to pay. */
  sourcePaymentAccountId: string;
  /** Counterparty expense or asset account. */
  counterpartyExpenseAccountId: string;
  idempotencyKey?: string | null;
  actorId?: string | null;
};

export type FundTransferInput = {
  organizationId: string;
  sourceLegalEntityId: string;
  counterpartyLegalEntityId: string;
  entryDate: string;
  amount: number;
  description: string;
  sourceCashAccountId: string;
  counterpartyCashAccountId: string;
  idempotencyKey?: string | null;
  actorId?: string | null;
};

export type CashReceivedOnBehalfInput = {
  organizationId: string;
  sourceLegalEntityId: string;
  counterpartyLegalEntityId: string;
  entryDate: string;
  amount: number;
  description: string;
  sourceCashAccountId: string;
  /** Counterparty revenue or clearing account. */
  counterpartyCreditAccountId: string;
  idempotencyKey?: string | null;
  actorId?: string | null;
};
