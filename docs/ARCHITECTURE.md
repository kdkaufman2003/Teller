# Teller architecture

Quick reference for how the system is layered. Full policy: [SPEC.md](./SPEC.md).

## System context

```
┌─────────────┐     HTTPS webhooks      ┌─────────────┐
│ Hassle Free │ ───────────────────────▶│   Teller    │
│     AC      │   Bearer shared secret  │  (Next.js)  │
└──────┬──────┘                         └──────┬──────┘
       │                                       │
       ▼                                       ▼
   HFAC Supabase                          Teller Supabase
   (separate project)                    (Auth + Postgres + RLS)
```

Teller and HFAC **never share a database**.

## Application layers

```
┌──────────────────────────────────────────────────────────┐
│  UI (App Router) — /app/* pages, forms, ledger view      │
├──────────────────────────────────────────────────────────┤
│  API routes — requireBooks(), input validation           │
├──────────────────────────────────────────────────────────┤
│  Domain — accounting/post.ts, integrations/hfac.ts       │
├──────────────────────────────────────────────────────────┤
│  Data — Supabase client (user JWT) or service role       │
│         RLS enforces organization_id isolation           │
└──────────────────────────────────────────────────────────┘
```

## Tenant model

1. User signs in via Supabase Auth.
2. `teller_profiles` links user → `organization_id` + `role`.
3. Every query filters by session organization (app) or verifies membership (RLS).
4. Inbound HFAC webhooks use service role + explicit `organizationId` in signed payload.

## Accounting flow

**Manual invoice:**

```
InvoiceForm → POST /api/invoices → teller_documents (draft)
           → post action → postInvoiceOpen() → journal entry (Dr AR, Cr Revenue)
           → mark paid → postInvoicePaid() → journal entry (Dr Cash, Cr AR)
```

**HFAC billing sync:**

```
HFAC billing ledger → POST /hfac/billing → importBillingEntriesFromHfac()
                    → postInvoiceOpen / postInvoicePaid as needed
```

All posting goes through `src/lib/accounting/post.ts` with `assertBalanced()`.

## Integration adapter pattern (target)

```
src/lib/accounting/          ← provider-agnostic core
src/lib/integrations/
  hfac.ts                    ← HFAC adapter (maps external payloads → core)
  constants.ts               ← external_source identifiers
  hfac-auth.ts               ← webhook verification
```

New providers add a folder/module; they call the same posting primitives.

## Key files

| Concern | Path |
|---------|------|
| Session + org | `src/lib/session.ts` |
| API guard | `src/lib/api.ts` |
| Posting | `src/lib/accounting/post.ts` |
| HFAC import | `src/lib/integrations/hfac.ts` |
| Schema + RLS | `supabase/migrations/001_teller_core.sql` |
| Partner attach | `supabase/migrations/002_partner_attachment.sql` |

## Environment separation

| Env | Purpose |
|-----|---------|
| Local | `.env.local`, local Supabase or dev project |
| Production | Vercel + Teller Supabase — real customer data |

Do not copy production ledger data to local without sanitization.
