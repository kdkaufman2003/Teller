# Teller

Industry-tailored books. A short setup interview builds the chart of accounts, labels, and modules for HVAC/trades, SaaS, or a general business. First books: **Hassle Free AC dealers**, connected to [Quoter](../Quoter).

## Stack

Same family as Quoter:

- **GitHub** — source and Vercel deploys
- **Supabase** — Auth, Postgres ledger, Row Level Security
- **Vercel** — Next.js hosting
- **Next.js 16** App Router + Tailwind 4

Teller tables are prefixed `teller_`, so they can live in the **same Supabase project as Quoter** without colliding with `dealer_accounts` or quote tables.

## What setup asks (HVAC)

- Dealer vs contractor vs service vs mixed
- What to call customers (Dealers, Contractors, Homeowners…)
- Accrual vs cash, fiscal year
- Revenue streams: equipment, labor, service, maintenance, parts, warranty
- Job costing, inventory, sales tax, warranty reserve
- Connect Hassle Free AC Quoter

Answers seed accounts such as Equipment Sales, Installation Labor, and Warranty Reserve, and turn on Jobs + Quoter sync when you say yes.

## Local development

```bash
cd Teller
cp .env.example .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Supabase

1. Use the existing Hassle Free AC Quoter project, or create a new one at [supabase.com](https://supabase.com).
2. SQL Editor → run `supabase/migrations/001_teller_core.sql`.
3. Authentication → URL Configuration:
   - Site URL: `http://localhost:3000` (add the Vercel URL later)
   - Redirect URL: `http://localhost:3000/auth/callback`
4. Copy **Project URL**, **anon/publishable key**, and **service_role** into `.env.local`.

Email signup works with the default Supabase Auth settings. Confirm email can stay on; check the inbox (or disable confirmations in Auth → Providers for local testing).

## GitHub + Vercel

1. Create a GitHub repo and push this folder.
2. [Import the repo in Vercel](https://vercel.com/new). Next.js is auto-detected.
3. Add the same env vars as `.env.example`.
4. After the first deploy, add the production URL to Supabase Auth redirect allowlist:
   - `https://<your-teller>.vercel.app/auth/callback`

## Connect Quoter

Teller is **its own app**. Attachment to Hassle Free AC is optional and reversible under **Settings → Program mode**.

### Standalone (default)

Run setup without `?attach=hasslefreeac`. No Quoter sync, full books for any industry.

### Attach to Hassle Free AC

1. Landing → **Attach to Hassle Free AC**, or Settings → **Attach to Hassle Free AC** after setup.
2. Run migration `002_partner_attachment.sql` if you already ran `001`.
3. Point both apps at the same Supabase project (recommended) or use the webhook below.

Two sync paths when attached:

1. **Shared Supabase** — Settings → **Sync dealers & won quotes** reads Quoter tables in the same project.
2. **Live webhook** — Quoter env when a quote is marked won:

```
TELLER_WEBHOOK_URL=https://<your-teller>.vercel.app/api/integrations/quoter/quotes
TELLER_WEBHOOK_SECRET=<same as Teller>
TELLER_ORGANIZATION_ID=<Settings → webhook id>
```

In **Quoter**, add `NEXT_PUBLIC_TELLER_URL` so the footer links back to Teller books.

**Detach** anytime in Settings — Quoter sync turns off; invoices and ledger data stay in Teller.

In **Teller** env for inbound webhooks:

```
TELLER_QUOTER_WEBHOOK_SECRET=<same secret>
SUPABASE_SERVICE_ROLE_KEY=<required for inbound quotes>
```

Marking a mini-split quote **won** in Quoter creates a draft invoice (and job) without blocking the save.

## First-run path for Hassle Free AC

1. Sign up in Teller.
2. Landing → **Attach to Hassle Free AC** (or Settings → attach later).
3. Complete HVAC setup; Quoter sync is enabled automatically.
4. Settings → **Sync dealers & won quotes**.
5. Review imported dealers and draft invoices, then **Save & post** / **Mark paid**.

## App map

| Route | Purpose |
|-------|---------|
| `/setup` | Industry interview |
| `/app` | Receivables, collected, jobs, Quoter status |
| `/app/invoices` | Draft → post (AR + revenue) → paid (cash) |
| `/app/customers` | Dealers / customers |
| `/app/jobs` | Install / service job costing |
| `/app/expenses` | Vendor spend posted to the ledger |
| `/app/accounts` | Industry chart of accounts |
| `/app/ledger` | Double-entry journal |

## Tests

```bash
npm test
```
