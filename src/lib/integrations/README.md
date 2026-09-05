# Integrations layer

External systems connect to Teller through **adapters** — not by writing directly to accounting tables from random API routes.

## Pattern

```
Provider event → webhook/API route → adapter (hfac.ts) → accounting/post.ts → Postgres
```

## Current providers

| Provider | Adapter | Routes |
|----------|---------|--------|
| Hassle Free AC | `hfac.ts` | `/api/integrations/hfac/*` |

Legacy `quoter.ts` routes remain for backward compatibility; new work uses HFAC naming.

## Adding a provider

1. Create `src/lib/integrations/<name>.ts` with import functions that call `post.ts`.
2. Add authenticated webhook route(s) under `src/app/api/integrations/<name>/`.
3. Use `external_source` + `external_id` on parties/documents for idempotent upserts.
4. Document env vars in root `README.md`.
5. Add tests for auth rejection and happy-path import.

## HFAC payload map

| HFAC concept | Teller entity |
|--------------|---------------|
| Contractor company | `teller_parties` (customer) |
| Billing ledger entry | `teller_documents` (invoice) |
| Won deal | `teller_documents` + optional `teller_jobs` |
| Stripe payment | `postInvoicePaid()` via payment webhook |

See root `README.md` for webhook JSON examples.
