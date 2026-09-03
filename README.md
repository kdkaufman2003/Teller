# Teller

Industry-tailored accounting software. A short setup interview builds the chart of accounts, labels, and modules for HVAC/trades, SaaS, or a general business.

Teller is a **standalone product** with its own Supabase project. **Hassle Free AC** is an optional integration — not a dependency.

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
2. SQL Editor → run `supabase/migrations/001_teller_core.sql` then `002_partner_attachment.sql`.
3. Authentication → URL Configuration:
   - Site URL: `http://localhost:3000` (add Vercel URL after deploy)
   - Redirect URL: `http://localhost:3000/auth/callback`
4. Copy Project URL, anon key, and service_role into `.env.local`.

## Deploy (Vercel)

1. Import the GitHub repo.
2. Set env vars from `.env.example`.
3. Add production URL to Supabase Auth redirects: `https://<teller>.vercel.app/auth/callback`

## Hassle Free AC integration

Teller and Hassle Free AC each have **their own repo, Vercel URL, and Supabase**. They talk over HTTP only.

### Teller setup

1. Deploy Teller with its own Supabase.
2. **Settings → Integrations → Connect Hassle Free AC**
3. Copy **Webhook organization id** from Settings.
4. Set `TELLER_HFAC_WEBHOOK_SECRET` in Teller env.

### Hassle Free AC setup

In the **Hassle Free AC** project env:

```
NEXT_PUBLIC_TELLER_INTEGRATION=1
NEXT_PUBLIC_TELLER_URL=https://<your-teller>.vercel.app
TELLER_WEBHOOK_URL=https://<your-teller>.vercel.app/api/integrations/hfac/quotes
TELLER_WEBHOOK_SECRET=<same as Teller TELLER_HFAC_WEBHOOK_SECRET>
TELLER_ORGANIZATION_ID=<uuid from Teller Settings>
```

When a deal is marked won in Hassle Free AC, Teller receives a draft invoice (and job if job costing is on).

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
| `/app/expenses` | Vendor spend |
| `/app/accounts` | Chart of accounts |
| `/app/ledger` | General ledger |
| `/app/settings` | Company + Hassle Free AC integration |

## Tests

```bash
npm test
```
