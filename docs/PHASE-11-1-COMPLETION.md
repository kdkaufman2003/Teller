# Phase 11.1 — Accrual-to-bill settlement (production complete)

**Completed:** 2026-09-07  
**Migration:** `028_phase11_1_accrual_settlement.sql` (manually applied in Supabase SQL Editor)  
**Production deploy:** `https://teller-indol.vercel.app`  
**Git commit (application):** `0655b9a`  
**Deployment ID:** `dpl_9TnchvQbWCTxkQjkAwQ5LtH4xC4C`

## Gates

| Gate | Result |
|------|--------|
| Migration 028 verified (REST / Supabase probes) | PASS — settlement tables, allocation tax lineage columns, scheduler run history, RLS-queryable |
| pg_catalog deep verification | **Unavailable** — `SUPABASE_DB_URL` not configured; REST table/column probes used instead |
| Local unit tests | **516/516** |
| Phase 11.1 controlled logic matrix | **88/88** |
| Phase 11.1 DB acceptance (demo org only) | **23/23** |
| Deployment compat audit | PASS |
| Phase 5–11 regressions (pre-deploy) | 18/18, 32/32, 45/45, 67/67, 102/102, 110/110, 105/105 |
| HFAC baseline unchanged | 8 docs, 3 payments, 3 allocations, 16 journals, AR $1,500, Phase 11 schedules 0, Phase 11.1 settlements 0 |
| Production journals balanced | 0 unbalanced |
| Production smoke test | PASS — `/login` 200; protected app routes 307; cron GET reports `enabled: false` |
| Post-deploy controlled re-run | 516/516 verify, 88/88 logic, 23/23 DB, HFAC unchanged |

## Schema (migration 028)

- `teller_accrual_settlements` — bill-linked accrual settlement header with variance totals
- `teller_accrual_settlement_allocations` — per-accrual allocation with tax lineage (`actual_pre_tax_allocated`, `nonrecoverable_tax_allocated`, `recoverable_tax_allocated`)
- `teller_scheduler_runs` — durable scheduler execution history (cron remains disabled)
- Over-settlement DB guard, idempotency constraints, RLS via org membership
- **Unchanged:** `teller_post_journal` signature; Phase 9 close; Phase 10 reporting; Phase 11 schedules

## Application deliverables

- Accrual settlements hub (`/app/accounting/accrual-settlements`)
- Eligible accrual picker on bill form and settlement composer
- Settlement preview, partial settlement, multi-accrual settlement
- Variance preview/report; bill linkage; settlement history; reversal workflow
- Bill void guard — active settlement blocks void until reversed
- Line-level purchase tax attribution (explicit → proportional → error)
- Recoverable input tax → input-tax asset when explicitly configured
- Close readiness findings for unsettled accruals
- Controlled harness: `setup:phase11-1-demo-org`, `verify:phase11-1:controlled`, `demo:phase11-1:controlled`, `accept:phase11-1:controlled`

## Accounting model (V1)

- **Exact settlement** creates no duplicate expense — only liability relief + AP
- **Positive / negative variance** posts to the accrual allocation expense account(s), proportional by default
- **Partial settlement** preserves remaining accrual capacity until fully settled
- **Multiple accrual accounts** retain lineage through allocation rows
- **Multiple bills** can settle one accrual; one bill can settle multiple accruals
- **Settled bill cannot be voided** until settlement is explicitly reversed
- **Settlement reversal** restores accrual capacity and bill void eligibility
- **Line-level purchase tax** follows the economic source bill line (never sales-tax-payable for vendor purchase tax)
- **Recoverable input tax** posts to configured input-tax asset; nonrecoverable tax capitalizes into expense/asset
- **AP equals full bill economics**; later bill payment remains Dr AP / Cr Cash only
- **Original accrual journal** remains immutable (reversal workflow only)

## Phase 11.1 demo org

- **Name:** Teller Phase 11.1 Demo  
- **ID:** `309f03cd-6794-43f2-aecd-c70c73eba92b`  
- All Phase 11.1 DB acceptance mutates this org only — never HFAC or other phase demo orgs.

## Acceptance snapshots

- Post: `artifacts/controlled-prod-snapshots/post-phase11-1-2026-09-07T21-29-20-450Z.json`

## Post-deploy accounting checks (controlled demo org)

| Check | Result |
|-------|--------|
| EXACT_SETTLEMENT_PASS | true |
| POSITIVE_VARIANCE_PASS | true |
| NEGATIVE_VARIANCE_PASS | true |
| PARTIAL_SETTLEMENT_PASS | true |
| MULTI_ACCOUNT_SETTLEMENT_PASS | true |
| BILL_VOID_GUARD_PASS | true |
| SETTLEMENT_REVERSAL_PASS | true |
| LINE_LEVEL_TAX_PASS | true |
| RECOVERABLE_INPUT_TAX_PASS | true |
| BILL_PAYMENT_NO_DUPLICATE_EXPENSE_PASS | true |

## Deferred (not blocking Phase 11.1)

- **Production scheduler/cron** — `PRODUCTION_SCHEDULER_CRON` deferred pending separate authorization; `/api/cron/process-schedules` POST returns 503; no Vercel cron configured
- **pg_catalog deep verification** — requires `SUPABASE_DB_URL` (not configured)

## Flags

```
PHASE_11_1_COMPLETE = true
PRODUCTION_DEPLOYED = true
PRODUCTION_SCHEDULER_ENABLED = false
PHASE_12_STARTED = false
```
