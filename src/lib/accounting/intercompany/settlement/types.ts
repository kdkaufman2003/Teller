export type IntercompanySettlementStatus =
  | "draft"
  | "posted"
  | "partially_reconciled"
  | "reconciled"
  | "reversed";

export type IntercompanySettlementMode = "itemized" | "net";

export type SettlementAllocationInput = {
  intercompanyTransactionId: string;
  amountApplied: number;
};

export type PostIntercompanySettlementInput = {
  organizationId: string;
  payerLegalEntityId: string;
  payeeLegalEntityId: string;
  settlementDate: string;
  amount: number;
  reference?: string | null;
  memo?: string;
  allocations: SettlementAllocationInput[];
  payerBankAccountId?: string | null;
  payeeBankAccountId?: string | null;
  settlementMode?: IntercompanySettlementMode;
  idempotencyKey?: string | null;
  actorId?: string | null;
};

export type IntercompanyOpenItem = {
  intercompanyTransactionId: string;
  transactionDate: string;
  transactionType: string;
  reference: string | null;
  description: string;
  originalAmount: number;
  settledAmount: number;
  remainingAmount: number;
  sourceLegalEntityId: string;
  counterpartyLegalEntityId: string;
  sourceJournalId: string | null;
  counterpartyJournalId: string | null;
  status: string;
};

export type IntercompanyPairReconciliation = {
  entityAId: string;
  entityBId: string;
  asOf: string;
  aDueFromB: number;
  aDueToB: number;
  bDueFromA: number;
  bDueToA: number;
  receivablePayableDifference: number;
  payableReceivableDifference: number;
  netAOwesB: number;
  netBOwesA: number;
  balanced: boolean;
  openBalance: number;
  settledDuringPeriod: number;
  openItemsCount: number;
  openItems: IntercompanyOpenItem[];
  lastActivity: string | null;
  status: "RECONCILED" | "OUT_OF_BALANCE" | "OPEN_BALANCE" | "PENDING_REVIEW";
};

export type IntercompanySettlementRow = {
  id: string;
  organizationId: string;
  payerLegalEntityId: string;
  payeeLegalEntityId: string;
  settlementDate: string;
  amount: number;
  currency: string;
  status: IntercompanySettlementStatus;
  settlementMode: IntercompanySettlementMode;
  payerJournalId: string | null;
  payeeJournalId: string | null;
  reference: string | null;
  memo: string;
  idempotencyKey: string | null;
  createdAt: string;
  postedAt: string | null;
  reversalSettlementId: string | null;
  reversedAt: string | null;
};
