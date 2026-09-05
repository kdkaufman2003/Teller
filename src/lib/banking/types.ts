export const PLAID_PROVIDER = "plaid" as const;

export type BankingProviderName = typeof PLAID_PROVIDER;

export type BankConnectionStatus = "active" | "error" | "disconnected";

export type BankTransactionMatchStatus = "unmatched" | "suggested" | "matched" | "ignored";

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

export type NormalizedBankTransaction = {
  externalTransactionId: string;
  externalAccountId: string;
  postedDate: string;
  authorizedDate?: string | null;
  amount: number;
  name: string;
  merchantName?: string | null;
  pending: boolean;
  category?: string[];
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
