# Phase 12 — Payroll & labor accounting

**Status:** Production complete — see [PHASE-12-COMPLETION.md](./PHASE-12-COMPLETION.md)

Teller V1 is **not** a payroll processor. Phase 12 makes Teller the accounting system of record for payroll and labor economics from external providers.

## Scope

- Payroll run recognition (wages, withholdings, employer taxes, net pay clearing)
- Worker accounting identity (no SSN/bank/tax forms)
- Configurable component → GL account mappings
- Labor allocation to jobs with employer burden
- Phase 7 job profitability integration (`directLaborCost`, `employerLaborBurden`, `totalLaborCost`)
- Provider-neutral import (CSV/JSON/generic adapter)
- Payroll reversal, period locks, liability settlement (no duplicate expense)
- Claim-before-post atomic RPCs (migration 030) — no orphan payroll journals
- Close readiness, reporting, accountant package hooks
- HFAC hard refusal — future technician/time integration boundary only

## Out of scope

Payroll calculation, withholding, W-2/941, direct deposit, benefits admin, garnishments, workers comp admin.

## Migrations (manual apply only)

- `supabase/migrations/029_phase12_payroll_labor.sql` — tables + RLS
- `supabase/migrations/030_phase12_payroll_atomic_rpc.sql` — atomic posting RPCs (RPC-only)

Migrations were **never auto-applied**. Apply via Supabase SQL Editor or `npm run apply:migration:030:controlled` when `SUPABASE_DB_URL` is configured.

## Local / controlled gates

```bash
npm test
npm run build
npm run demo:phase12:controlled
npm run verify:migration:030:controlled
npm run accept:phase12:controlled
npm run audit:phase12:deployment-compat
```

## Demo orgs

- **Teller Phase 12 Demo** — `c1cd9cb4-6ea1-4fd4-b4f6-c94c5a5bfd96`
- **Teller Phase 12 Foreign Test** — `62d7e9d0-6da9-4814-b6a0-da831210d930`

Setup: `npm run setup:phase12-demo-org`

## UI routes

- `/app/accounting/payroll` — hub
- `/app/accounting/payroll/runs`, `/import`, `/workers`, `/mappings`, `/liabilities`, `/reconciliation`
- `/app/reports/labor-by-job`, `/labor-by-worker`, `/unallocated-labor`

## Flags

```
PHASE_12_COMPLETE = true
MIGRATION_029_APPLIED = true (manual)
MIGRATION_030_APPLIED = true (manual)
PRODUCTION_DEPLOYED = true
PRODUCTION_SCHEDULER_ENABLED = false
PHASE_13_STARTED = false
```
