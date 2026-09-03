# Teller

Industry-tailored accounting software. A short setup interview builds the chart of accounts, labels, and modules for HVAC/trades, SaaS, or a general business.

Teller is a standalone product — integrations with quoting and operational tools are optional and configured in **Settings → Integrations**.

## Stack

- **GitHub** — source and Vercel deploys
- **Supabase** — Auth, Postgres ledger, Row Level Security
- **Vercel** — Next.js hosting
- **Next.js 16** App Router + Tailwind 4

Teller tables are prefixed `teller_`, so they can share a Supabase project with other apps (e.g. a quoting platform) without table collisions.

## What setup asks

Setup adapts to the industry pack you choose:

- **HVAC & trades** — dealer vs contractor vs service, customer labels, revenue streams (equipment, labor, service…), job costing, tax, warranty reserve
- **SaaS** — subscription revenue, deferred revenue, MRR-oriented modules
- **General business** — a clean starting chart of accounts

Integrations are not required during setup. Connect quote-to-invoice sync later in Settings if needed.

## Local development

```bash
cd Teller
cp .env.example .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Supabase

1. Create a project at [supabase.com](https://supabase.com), or use an existing shared project.
2. SQL Editor → run `supabase/migrations/001_teller_core.sql`.
3. Authentication → URL Configuration:
   - Site URL: `http://localhost:3000` (add the Vercel URL later)
   - Redirect URL: `http://localhost:3000/auth/callback`
4. Copy **Project URL**, **anon/publishable key**, and **service_role** into `.env.local`.

Email signup works with the default Supabase Auth settings.

## GitHub + Vercel

1. Push this folder to GitHub.
2. [Import the repo in Vercel](https://vercel.com/new). Next.js is auto-detected.
3. Add the same env vars as `.env.example`.
4. After the first deploy, add the production URL to Supabase Auth redirect allowlist:
   - `https://<your-teller>.vercel.app/auth/callback`

## Integrations (optional)

Teller is **its own system of record**. Connect a quoting platform under **Settings → Integrations** to import customers and won quotes as draft invoices — disconnect anytime and keep your books.

### Standalone (default)

Complete setup normally. No integration sync; full books for any industry.

### Quote-to-invoice sync

1. Settings → **Connect quote-to-invoice sync**
2. Run migration `002_partner_attachment.sql` if you already ran `001`.
3. Point both apps at the same Supabase project (recommended) or use the webhook below.

Two sync paths when connected:

1. **Shared Supabase** — Settings → **Sync customers & won quotes** reads quote tables in the same project.
2. **Live webhook** — in the quoting app when a quote is marked won:

```
TELLER_WEBHOOK_URL=https://<your-teller>.vercel.app/api/integrations/quoter/quotes
TELLER_WEBHOOK_SECRET=<same as Teller>
TELLER_ORGANIZATION_ID=<Settings → webhook organization id>
```

In **Teller** env for inbound webhooks:

```
TELLER_QUOTER_WEBHOOK_SECRET=<same secret>
SUPABASE_SERVICE_ROLE_KEY=<required for inbound quotes>
```

**Disconnect** anytime in Settings — sync turns off; invoices and ledger data stay in Teller.

### Developer note: first integration partner

The first supported integration uses internal partner id `hasslefreeac` (Quoter). Enable it via Settings, or during setup with `?integrations=1` or `?attach=hasslefreeac`. This is not shown in the public UI.

## App map

| Route | Purpose |
|-------|---------|
| `/setup` | Industry interview |
| `/app` | Receivables, collected, jobs, integration status |
| `/app/invoices` | Draft → post (AR + revenue) → paid (cash) |
| `/app/customers` | Customers / dealers |
| `/app/jobs` | Install / service job costing |
| `/app/expenses` | Vendor spend posted to the ledger |
| `/app/accounts` | Industry chart of accounts |
| `/app/ledger` | Double-entry journal |
| `/app/settings` | Company info and integrations |

## Tests

```bash
npm test
```
