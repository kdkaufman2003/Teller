import { PLAID_PROVIDER, type BankingProvider } from "./types";
import { plaidProvider } from "./providers/plaid";

const providers: Record<string, BankingProvider> = {
  [PLAID_PROVIDER]: plaidProvider,
};

export function getBankingProvider(name: string = PLAID_PROVIDER): BankingProvider | null {
  return providers[name] ?? null;
}

export function bankingConfigured(name: string = PLAID_PROVIDER): boolean {
  return getBankingProvider(name)?.isConfigured() ?? false;
}
