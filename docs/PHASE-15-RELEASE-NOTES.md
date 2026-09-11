# Phase 15 Release Notes — Sales & Use Tax (V1)

**Release candidate:** Phase 15K (2026-09-11)  
**Scope:** Missouri + Kansas configuration packs (MO-2026.1, KS-2026.1)

## What's included

### Sales tax (15A–15D)
- Tax settings, registrations, jurisdictions, rates, and taxability rules
- Canonical tax calculation engine with determination snapshots
- Sales tax posting on invoices and credit memos
- Tax subledger aligned to Sales & Use Tax Payable GL account

### Exemptions (15C)
- Customer exemption certificates with jurisdiction/category scope
- Historical snapshot on posted documents — changing a certificate does not rewrite past tax

### Purchase / use tax (15E)
- Vendor bill tax comparison (fully taxed, partial vendor tax, untaxed accrual)
- Use tax accrual separate from AP — vendor-charged tax is not double-counted

### Filing periods (15F)
- Registration-driven period generation (monthly/quarterly/annual)
- Period reconciliation: subledger rollforward vs GL tax payable
- Filed period snapshots — filed truth is immutable

### Tax authority payments (15G)
- Record payments with period allocation, penalty/interest separation
- Manual adjustments, payment reversals, idempotent resubmit
- Optional bank transaction match (no duplicate cash posting)

### State configuration packs (15H)
- MO-2026.1 and KS-2026.1 reference packs
- Destination/origin sourcing, local rate policy, HVAC fact-dependent review paths
- Unknown local jurisdiction → needs_review (not silent under-taxing)

### Reports & accountant package (15I)
- Tax summary, rollforward, GL reconciliation, sales/use detail, exempt, needs-review
- Payment and adjustment reports; jurisdiction/authority summaries
- Downloadable accountant package (CSV + README manifest); CSV formula-injection protection

### Owner tax dashboard (15J)
- Tax overview: Tax Owed, Tax Paid, Next Period, Needs Attention
- Owner-friendly filing period list/detail; accountant detail in CPA/bookkeeper mode
- Links to reports and accountant package

## Limitations (V1)

- **No automated tax return filing** — Teller tracks liability; it does not submit returns to government portals
- **No automated remittance** — payment recording is manual; no ACH/wire origination
- **No nexus determination** — org must configure where they collect tax
- **MO/KS only** — other states require future packs
- **Ambiguous facts → needs_review** — Teller does not guess tax when location, rate, or exemption facts are insufficient
- **Due dates** — shown only when configured; state due dates are not inferred
- **Production MO/KS reference loader** — global rate/rule loader is a separate deployment step (Phase 15L)

## Database (manual apply)

- `supabase/migrations/035_phase15_tax_accounting.sql`
- `supabase/patches/036_phase15d_tax_line_org_guard.sql`
- `supabase/migrations/037_phase15f_tax_filing_periods.sql`
- `supabase/migrations/038_phase15g_tax_authority_payments.sql`
- `supabase/patches/039_phase15g_tax_transaction_org_guard_fix.sql`

## Acceptance

- Controlled DB acceptance: 111 scenarios (15A–15K + HFAC baseline)
- Unit tests: phase15a–phase15j
- Full release gate: fast + phase + affected + full + controlled acceptance
