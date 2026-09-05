import { asNumber } from "@/lib/format";

type PlaidEnv = "sandbox" | "development" | "production";

function plaidEnv(): PlaidEnv {
  const raw = (process.env.PLAID_ENV || "sandbox").toLowerCase();
  if (raw === "production" || raw === "development") return raw;
  return "sandbox";
}

function plaidBaseUrl(env: PlaidEnv = plaidEnv()): string {
  if (env === "production") return "https://production.plaid.com";
  if (env === "development") return "https://development.plaid.com";
  return "https://sandbox.plaid.com";
}

function plaidHeaders() {
  const clientId = process.env.PLAID_CLIENT_ID?.trim();
  const secret = process.env.PLAID_SECRET?.trim();
  if (!clientId || !secret) {
    throw new Error("PLAID_CLIENT_ID and PLAID_SECRET are required");
  }
  return { clientId, secret };
}

async function plaidRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const { clientId, secret } = plaidHeaders();
  const response = await fetch(`${plaidBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      secret,
      ...body,
    }),
  });

  const payload = (await response.json()) as T & { error_message?: string; error_code?: string };
  if (!response.ok) {
    throw new Error(payload.error_message || payload.error_code || `Plaid request failed (${path})`);
  }
  return payload;
}

export function plaidIsConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID?.trim() && process.env.PLAID_SECRET?.trim());
}

type PlaidSyncPage = {
  added: Array<Record<string, unknown>>;
  modified: Array<Record<string, unknown>>;
  removed: Array<{ transaction_id: string }>;
  next_cursor: string;
  has_more: boolean;
};

export const plaidProvider = {
  name: "plaid" as const,

  isConfigured() {
    return plaidIsConfigured();
  },

  async createLinkToken(input: { organizationId: string; userId: string }) {
    const payload = await plaidRequest<{
      link_token: string;
      expiration: string;
    }>("/link/token/create", {
      user: { client_user_id: input.userId },
      client_name: "Teller",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
      webhook: process.env.PLAID_WEBHOOK_URL?.trim() || undefined,
      redirect_uri: process.env.PLAID_REDIRECT_URI?.trim() || undefined,
      transactions: { days_requested: 90 },
      // Stable id for multi-connection support per org
      metadata: { organization_id: input.organizationId },
    });

    return {
      linkToken: payload.link_token,
      expiration: payload.expiration,
    };
  },

  async exchangePublicToken(publicToken: string) {
    const payload = await plaidRequest<{
      access_token: string;
      item_id: string;
    }>("/item/public_token/exchange", {
      public_token: publicToken,
    });

    let institutionId: string | null = null;
    let institutionName: string | null = null;

    try {
      const item = await plaidRequest<{
        item: { institution_id?: string };
      }>("/item/get", {
        access_token: payload.access_token,
      });
      institutionId = item.item.institution_id ?? null;

      if (institutionId) {
        const institution = await plaidRequest<{
          institution: { name?: string };
        }>("/institutions/get_by_id", {
          institution_id: institutionId,
          country_codes: ["US"],
        });
        institutionName = institution.institution.name ?? null;
      }
    } catch {
      // Institution metadata is optional for connection storage.
    }

    return {
      accessToken: payload.access_token,
      itemId: payload.item_id,
      institutionId,
      institutionName,
    };
  },

  async fetchAccounts(accessToken: string) {
    const payload = await plaidRequest<{
      accounts: Array<{
        account_id: string;
        name: string;
        official_name?: string | null;
        mask?: string | null;
        type?: string;
        subtype?: string | null;
        balances?: { current?: number | null; iso_currency_code?: string | null };
      }>;
    }>("/accounts/get", {
      access_token: accessToken,
    });

    return payload.accounts.map((account) => ({
      externalAccountId: account.account_id,
      name: account.name,
      officialName: account.official_name ?? undefined,
      mask: account.mask ?? undefined,
      type: account.type,
      subtype: account.subtype ?? undefined,
      currency: account.balances?.iso_currency_code ?? "USD",
      currentBalance:
        account.balances?.current == null ? null : asNumber(account.balances.current),
    }));
  },

  async syncTransactions(accessToken: string, cursor?: string | null) {
    const payload = await plaidRequest<PlaidSyncPage>("/transactions/sync", {
      access_token: accessToken,
      cursor: cursor ?? undefined,
      count: 500,
    });

    const mapTxn = (row: Record<string, unknown>) => ({
      externalTransactionId: String(row.transaction_id),
      externalAccountId: String(row.account_id),
      postedDate: String(row.date).slice(0, 10),
      authorizedDate: row.authorized_date ? String(row.authorized_date).slice(0, 10) : null,
      amount: asNumber(row.amount),
      name: String(row.name || row.merchant_name || "Bank transaction"),
      merchantName: row.merchant_name ? String(row.merchant_name) : null,
      pending: Boolean(row.pending),
      category: Array.isArray(row.category)
        ? (row.category as string[])
        : [],
    });

    let added = payload.added.map(mapTxn);
    let modified = payload.modified.map(mapTxn);
    let removed = payload.removed.map((row) => row.transaction_id);
    let nextCursor: string | null = payload.next_cursor;
    let hasMore = payload.has_more;

    while (hasMore && nextCursor) {
      const page: PlaidSyncPage = await plaidRequest<PlaidSyncPage>("/transactions/sync", {
        access_token: accessToken,
        cursor: nextCursor,
        count: 500,
      });
      added = added.concat(page.added.map(mapTxn));
      modified = modified.concat(page.modified.map(mapTxn));
      removed = removed.concat(page.removed.map((row) => row.transaction_id));
      nextCursor = page.next_cursor;
      hasMore = page.has_more;
    }

    const accounts = await plaidProvider.fetchAccounts(accessToken);

    return {
      accounts,
      added,
      modified,
      removed,
      cursor: nextCursor,
    };
  },
};
