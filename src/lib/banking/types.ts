import type { BankDirection, BankTransactionStatus, MatchedResourceType } from "./normalize";

export const PLAID_PROVIDER = "plaid" as const;
export const MANUAL_CSV_PROVIDER = "manual_csv" as const;

export type BankingProviderName = typeof PLAID_PROVIDER | typeof MANUAL_CSV_PROVIDER;

export type BankConnectionStatus = "active" | "error" | "disconnected";

/** @deprecated Use BankTransactionStatus from normalize.ts */
export type BankTransactionMatchStatus = "unmatched" | "suggested" | "matched" | "ignored";

export type ProviderTransactionLifecycle = "active" | "provider_removed" | "superseded";

export type NormalizedBankAccount = {
  externalAccountId: string;
  name: string;
  officialName?: string;
  mask?: string;
  type?: string;
  subtype?: string;
  currency?: string;
  currentBalance?: number | null;
};

/** Canonical provider-neutral bank line for ingestion. */
export type NormalizedBankTransaction = {
  /** Provider transaction id (Plaid transaction_id, CSV fingerprint, etc.) */
  providerTransactionId: string;
  /** @deprecated Alias for providerTransactionId */
  externalTransactionId: string;
  providerAccountId: string;
  /** @deprecated Alias for providerAccountId */
  externalAccountId: string;
  providerPendingTransactionId?: string | null;
  postedDate: string;
  authorizedDate?: string | null;
  /** Provider/raw signed amount — never use directly in accounting logic. */
  rawAmount: number;
  /** @deprecated Alias for rawAmount */
  amount: number;
  normalizedAmount?: number;
  direction?: BankDirection | null;
  description: string;
  /** @deprecated Alias for description */
  name: string;
  merchantName?: string | null;
  transactionType?: string | null;
  pending: boolean;
  currency?: string;
  providerCategory?: string[];
  /** @deprecated Alias for providerCategory */
  category?: string[];
  rawProviderMetadata?: Record<string, unknown>;
  importFingerprint?: string | null;
  lifecycle?: ProviderTransactionLifecycle;
};

export type BankTransactionImportInput = {
  organizationId: string;
  bankAccountId: string;
  provider: BankingProviderName | string;
  providerConnectionId?: string | null;
  transactions: NormalizedBankTransaction[];
  removedProviderTransactionIds?: string[];
  importBatchId?: string | null;
};

export type BankImportResult = {
  imported: number;
  updated: number;
  superseded: number;
  removed: number;
  duplicates: number;
  errors: string[];
};

export type BankTransactionRpcRow = {
  provider_transaction_id: string;
  provider_pending_transaction_id?: string | null;
  posted_date: string;
  authorized_date?: string | null;
  amount: number;
  raw_amount: number;
  description: string;
  merchant_name?: string | null;
  transaction_type?: string | null;
  pending: boolean;
  currency?: string;
  provider_category?: string[];
  raw_provider_metadata?: Record<string, unknown>;
  import_fingerprint?: string | null;
};

export type MatchConfidenceTier = "exact" | "high" | "medium" | "low";

export type MatchSuggestionV2 = {
  resourceType: MatchedResourceType;
  resourceId: string;
  label: string;
  amount: number;
  date: string;
  confidence: number;
  confidenceTier: MatchConfidenceTier;
  reason: string;
  paymentType?: string | null;
  partyName?: string | null;
  referenceNumber?: string | null;
};

export type BankTransactionTab =
  | "for_review"
  | "matched"
  | "categorized"
  | "excluded"
  | "reconciled";

export const TAB_STATUS_MAP: Record<BankTransactionTab, BankTransactionStatus[]> = {
  for_review: ["unreviewed", "suggested", "partially_matched"],
  matched: ["matched"],
  categorized: ["categorized"],
  excluded: ["excluded"],
  reconciled: ["reconciled"],
};

export type CsvColumnMapping = {
  date: string;
  description?: string;
  payee?: string;
  memo?: string;
  amount?: string;
  debit?: string;
  credit?: string;
};

export type CsvParseResult = {
  rows: NormalizedBankTransaction[];
  errors: Array<{ row: number; message: string }>;
  duplicates: string[];
  skipped: number;
};

export type BankingLinkTokenResult = {
  linkToken: string;
  expiration: string;
};

export type BankingExchangeResult = {
  accessToken: string;
  itemId: string;
  institutionId?: string | null;
  institutionName?: string | null;
};

export type BankingSyncResult = {
  accounts: NormalizedBankAccount[];
  added: NormalizedBankTransaction[];
  modified: NormalizedBankTransaction[];
  removed: string[];
  cursor?: string | null;
};

export type BankAccountBalanceSummary = {
  bankAccountId: string;
  providerBalance: number | null;
  bookBalance: number;
  clearedBalance: number;
  difference: number;
  lastSyncedAt: string | null;
};

export type CategorizeKind =
  | "expense"
  | "bank_fee"
  | "interest_income"
  | "interest_expense"
  | "owner_contribution"
  | "owner_draw";

export type BankSplitInput = {
  accountId: string;
  amount: number;
  partyId?: string | null;
  jobId?: string | null;
  memo?: string;
};

export type TransferPairCandidate = {
  sourceTransactionId: string;
  destinationTransactionId: string;
  amount: number;
  transferDate: string;
  confidence: number;
  reason: string;
  /** True when source/destination bank accounts belong to different companies. */
  crossEntity?: boolean;
};

export type ReconciliationSummary = {
  reconciliationId: string;
  bankAccountId: string;
  statementStartDate: string;
  statementEndDate: string;
  beginningReconciledBalance: number;
  statementEndingBalance: number;
  clearedIncreases: number;
  clearedDecreases: number;
  calculatedEndingBalance: number;
  difference: number;
  status: string;
};

export type ReconciliationRecord = {
  id: string;
  bankAccountId: string;
  statementStartDate: string;
  statementEndDate: string;
  beginningReconciledBalance: number;
  statementEndingBalance: number;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  startedBy: string | null;
  completedBy: string | null;
  reopenedBy: string | null;
};

export type ReconciliationItemDetail = {
  id: string;
  bankTransactionId: string | null;
  journalEntryId: string | null;
  journalLineId: string | null;
  clearedAmount: number;
  clearedDate: string;
  signedAmount: number;
  postedDate: string | null;
  description: string | null;
  status: string | null;
  provider: string | null;
  matchStatus: string | null;
};

export type ReconciliationCandidate = {
  bankTransactionId: string;
  postedDate: string;
  description: string;
  normalizedAmount: number;
  moneyIn: number;
  moneyOut: number;
  status: string;
  provider: string | null;
  cleared: boolean;
  reconciliationItemId: string | null;
  lockedElsewhere: boolean;
};

export type ReconciliationLandingAccount = {
  bankAccountId: string;
  name: string;
  mask: string | null;
  accountType: string | null;
  accountSubtype: string | null;
  institutionName: string | null;
  providerBalance: number | null;
  bookBalance: number;
  lastSyncedAt: string | null;
  lastReconciledDate: string | null;
  lastReconciledEndingBalance: number | null;
  activeReconciliation: {
    id: string;
    status: string;
    statementEndDate: string;
  } | null;
};

export type ReconciliationWorkspacePayload = {
  reconciliation: ReconciliationRecord;
  summary: ReconciliationSummary;
  items: ReconciliationItemDetail[];
  candidates: ReconciliationCandidate[];
  bankAccount: {
    id: string;
    name: string;
    mask: string | null;
    accountType: string | null;
    accountSubtype: string | null;
    glKind: "asset_bank" | "credit_card_liability";
  };
  auditEvents: Array<{
    action: string;
    createdAt: string;
    metadata: Record<string, unknown> | null;
  }>;
};

export const EDITABLE_RECONCILIATION_STATUSES = ["draft", "in_progress", "reopened"] as const;
export const ACTIVE_RECONCILIATION_STATUSES = ["draft", "in_progress", "reopened"] as const;

/** Provider adapter — no money movement, read-only bank data import. */
export type BankingProvider = {
  name: BankingProviderName;
  isConfigured(): boolean;
  createLinkToken(input: { organizationId: string; userId: string }): Promise<BankingLinkTokenResult>;
  exchangePublicToken(publicToken: string): Promise<BankingExchangeResult>;
  fetchAccounts(accessToken: string): Promise<NormalizedBankAccount[]>;
  syncTransactions(
    accessToken: string,
    cursor?: string | null,
  ): Promise<BankingSyncResult>;
};

/** Normalize legacy or partial transaction shapes into canonical form. */
export function toNormalizedBankTransaction(
  input: Partial<NormalizedBankTransaction> & {
    externalTransactionId?: string;
    externalAccountId?: string;
    amount?: number;
    name?: string;
    category?: string[];
  },
): NormalizedBankTransaction {
  const providerTransactionId =
    input.providerTransactionId ?? input.externalTransactionId ?? "";
  const providerAccountId = input.providerAccountId ?? input.externalAccountId ?? "";
  const rawAmount = input.rawAmount ?? input.amount ?? 0;
  const description = input.description ?? input.name ?? "Bank transaction";

  return {
    providerTransactionId,
    externalTransactionId: providerTransactionId,
    providerAccountId,
    externalAccountId: providerAccountId,
    providerPendingTransactionId: input.providerPendingTransactionId ?? null,
    postedDate: input.postedDate ?? "",
    authorizedDate: input.authorizedDate ?? null,
    rawAmount,
    amount: rawAmount,
    normalizedAmount: input.normalizedAmount,
    direction: input.direction,
    description,
    name: description,
    merchantName: input.merchantName ?? null,
    transactionType: input.transactionType ?? null,
    pending: Boolean(input.pending),
    currency: input.currency ?? "USD",
    providerCategory: input.providerCategory ?? input.category ?? [],
    category: input.providerCategory ?? input.category ?? [],
    rawProviderMetadata: input.rawProviderMetadata ?? {},
    importFingerprint: input.importFingerprint ?? null,
    lifecycle: input.lifecycle ?? "active",
  };
}
