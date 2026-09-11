# Teller

Industry-tailored accounting software. A short setup interview builds the chart of accounts, labels, and modules for HVAC/trades, SaaS, or a general business.

Teller is a **standalone product** with its own Supabase project. **Hassle Free AC** is an optional integration — not a dependency.

**Product spec & architecture:** [docs/SPEC.md](docs/SPEC.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [Implementation status](docs/IMPLEMENTATION-STATUS.md)

## Stack

- **GitHub** — source and Vercel deploys
- **Supabase** — Teller's own Auth + Postgres ledger
- **Vercel** — Next.js hosting
- **Next.js 16** App Router + Tailwind 4

## Local development

```bash
cd Teller
cp .env.example .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Supabase (Teller project)

1. Create a **new** Supabase project for Teller at [supabase.com](https://supabase.com).
2. SQL Editor → run migrations in order: `001_teller_core.sql`, `002_partner_attachment.sql`, `003_expense_receipts.sql`.
3. Authentication → URL Configuration:
   - Site URL: `http://localhost:3000` (add Vercel URL after deploy)
   - Redirect URL: `http://localhost:3000/auth/callback`
4. Copy Project URL, anon key, and service_role into `.env.local`.

## Deploy (Vercel)

1. Import the GitHub repo.
2. Set env vars from `.env.example`.
3. Add production URL to Supabase Auth redirects: `https://<teller>.vercel.app/auth/callback`

## Hassle Free AC integration (optional)

Teller is **fully standalone**. Integrations are shortcuts for Hassle Free AC — not required for any customer.

Teller and Hassle Free AC each have **their own repo, Vercel URL, and Supabase**. They talk over HTTP only.

### Teller setup

1. Deploy Teller with its own Supabase.
2. Use Teller normally (manual customers, invoices, expenses) — no integration needed.
3. **Optional:** Settings → Integrations → Connect Hassle Free AC
4. Copy **Webhook organization id** from Settings.
5. Set `TELLER_HFAC_WEBHOOK_SECRET` in Teller env.

### Hassle Free AC setup (optional)

In the **Hassle Free AC** project env:

```
NEXT_PUBLIC_TELLER_INTEGRATION=1
NEXT_PUBLIC_TELLER_URL=https://<your-teller>.vercel.app
TELLER_WEBHOOK_SECRET=<same as Teller TELLER_HFAC_WEBHOOK_SECRET>
TELLER_ORGANIZATION_ID=<uuid from Teller Settings>
# Optional override; default is the HFAC platform org id
# TELLER_COMPANY_ID=a1000000-0000-4000-8000-000000000001
TELLER_SUBSCRIBERS_URL=https://<your-teller>.vercel.app/api/integrations/hfac/subscribers
TELLER_QUOTES_URL=https://<your-teller>.vercel.app/api/integrations/hfac/quotes
TELLER_PAYMENTS_URL=https://<your-teller>.vercel.app/api/integrations/hfac/payments
TELLER_BILLING_URL=https://<your-teller>.vercel.app/api/integrations/hfac/billing
```

All requests use `Authorization: Bearer <TELLER_WEBHOOK_SECRET>`.

#### Subscribers + billing (Platform billing sync)

Push contractors and billing ledger entries from HFAC **Platform billing → Sync contractors & billing to Teller**.

- `POST /api/integrations/hfac/subscribers` — customers
- `POST /api/integrations/hfac/billing` — invoiced/paid ledger rows

Billing entries may include Stripe settlement fields (cents):

```json
{
  "organizationId": "<uuid>",
  "entries": [{
    "id": "ledger-row-1",
    "companyId": "hfac-account-123",
    "date": "2026-03-01",
    "description": "March platform fee",
    "amountCents": 150000,
    "status": "paid",
    "stripeInvoiceId": "in_...",
    "stripeFeeCents": 4350,
    "netReceivedCents": 145650
  }]
}
```

Teller also accepts `feeAmountCents` / `netAmountCents` if you prefer generic processor names.

```json
POST /api/integrations/hfac/subscribers
{
  "organizationId": "<uuid>",
  "subscribers": [
    {
      "id": "hfac-account-123",
      "name": "ABC Mechanical",
      "email": "billing@abc.com",
      "phone": "555-0100",
      "status": "active"
    }
  ]
}
```

Creates or updates customers in Teller (`external_source: hfac`). Send on connect for backfill, then on create/update.

#### Won deals

When a deal is marked won in Hassle Free AC, POST to `/api/integrations/hfac/quotes` — Teller creates a draft invoice (and job if job costing is on).

#### Stripe payments (via HFAC)

HFAC keeps Stripe; Teller stays the ledger. When Stripe confirms payment, HFAC forwards:

```json
POST /api/integrations/hfac/payments
{
  "organizationId": "<uuid>",
  "payment": {
    "amount": 1200.00,
    "feeAmount": 35.40,
    "netAmount": 1164.60,
    "processor": "stripe",
    "paidAt": "2026-03-03T18:00:00Z",
    "hfacSubscriberId": "hfac-account-123",
    "hfacDealId": "deal-456",
    "stripePaymentIntentId": "pi_..."
  }
}
```

Teller finds the matching invoice, posts it if needed, marks it paid, and records:

- **Dr Cash** — net deposit after fees
- **Dr Payment Processing Fees** — processor fee (Stripe, Square, etc.)
- **Cr Accounts Receivable** — full invoice amount

Send either `feeAmount` or `netAmount` (or both). Other processors work the same way via `processor`.

**Disconnect** anytime in Teller Settings — books stay in Teller.

### Standalone (no HFAC)

Complete setup normally. No env vars on HFAC, no connection in Teller Settings. Full books for any industry.

## App map

| Route | Purpose |
|-------|---------|
| `/setup` | Industry interview |
| `/app` | Dashboard, receivables, HFAC status |
| `/app/invoices` | Draft → post → paid |
| `/app/customers` | Customers / dealers |
| `/app/jobs` | Job costing |
| `/app/expenses` | Receipt upload, mileage, vendor spend |
| `/app/accounts` | Chart of accounts |
| `/app/ledger` | General ledger |
| `/app/reports` | Sales analysis & profit & loss |
| `/app/settings` | Company + Hassle Free AC integration |

## Tests

```bash
npm test
```
