# Banking adapter (Phase 7)

Read-only bank import via a provider abstraction. V1 uses **Plaid**; the accounting engine stays provider-agnostic.

## Principles

- **No bank passwords** — OAuth/link flow only through Plaid Link
- **No money movement** — transactions import + matching only
- **Standalone** — works without HFAC
- **Secrets server-only** — access tokens in `teller_bank_connection_secrets` (service role only)

## Architecture

```
Plaid Link → /api/banking/exchange → src/lib/banking/sync.ts
                                   → teller_bank_accounts
                                   → teller_bank_transactions
                                   → match suggestions → user confirm
```

## Environment

```env
PLAID_CLIENT_ID=
PLAID_SECRET=
PLAID_ENV=sandbox
# Optional:
# PLAID_WEBHOOK_URL=
# PLAID_REDIRECT_URI=
```

Also requires `SUPABASE_SERVICE_ROLE_KEY` for token storage.

## API

| Route | Purpose |
|-------|---------|
| `GET /api/banking` | Connection + account status |
| `POST /api/banking/link-token` | Start Plaid Link |
| `POST /api/banking/exchange` | Exchange public token or sync |
| `GET /api/banking/transactions` | List / suggest matches |
| `POST /api/banking/transactions` | Confirm or ignore match |

## UI

`/app/banking` — connect bank, sync, review imported lines and suggested matches.

## Adding another provider

Implement `BankingProvider` in `src/lib/banking/providers/` and register in `provider.ts`. Do not embed provider logic in invoice/expense routes.
