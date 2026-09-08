# Phase 12 — Payroll & labor accounting (production complete)

**Completed:** 2026-09-08  
**Migrations:** `029_phase12_payroll_labor.sql`, `030_phase12_payroll_atomic_rpc.sql` (both manually applied in Supabase SQL Editor — never auto-applied)  
**Production deploy:** `https://teller-indol.vercel.app`  
**Git commit (application):** `00d9e45`  
**Deployment ID:** `dpl_CWhNfxQHnNn6gpqGhtr4NDbUeaBV`

## Gates

| Gate | Result |
|------|--------|
| Migration 029 verified (REST probes) | PASS |
| Migration 030 verified (atomic RPC REST probes) | PASS |
| pg_catalog deep verification | **Unavailable** — `SUPABASE_DB_URL` not configured; REST RPC/table probes used instead |
| Local unit tests | **527/527** |
| Phase 12 controlled logic matrix | **110/110** |
| Phase 12 DB acceptance (demo org only) | **52/52** real scenarios, **0** placeholders |
| Deployment compat audit | PASS |
| Pre-deploy HFAC baseline | 8 docs, 3 payments, 3 allocations, 16 journals, AR $1,500, Phase 11 schedules 0, Phase 11.1 settlements 0, Phase 12 payroll runs 0, Phase 12 labor entries 0 |
| Production journals balanced | PASS |
| Production smoke test | PASS — `/login` 200; protected Phase 12 routes 307; cron GET `enabled: false` |
| Post-deploy controlled re-run | 527/527 verify, 110/110 logic, 52/52 DB, HFAC unchanged |
| `ORPHAN_PAYROLL_JOURNALS` | **0** |

## Schema (migration 029)

- `teller_workers` — accounting identity only (no SSN/bank/DOB)
- `teller_payroll_runs` — idempotent by `(organization_id, idempotency_key)` and `(organization_id, provider, external_run_id)`
- `teller_payroll_components` — normalized component amounts per run
- `teller_payroll_account_mappings` — one mapping per `component_category` per org
- `teller_labor_entries` — direct/indirect/unallocated labor with employer burden
- `teller_payroll_liability_settlements` — net pay / tax / benefit settlement with idempotency
- RLS via org membership on all Phase 12 tables
- **`teller_post_journal` signature unchanged**

## Atomic RPCs (migration 030 — RPC-only)

Claim-before-post concurrency hardening (no orphan journals, no best-effort cleanup):

- `teller_atomic_post_payroll_run` — `FOR UPDATE` row lock + org accounting lock before journal creation
- `teller_atomic_reverse_payroll_run` — same pattern for reversal journals
- `teller_atomic_post_payroll_settlement` — same pattern for settlement journals

Losers never call `teller_post_journal`. Canonical `journal_entry_id` / `reversal_journal_entry_id` on the payroll run or settlement row is the source of truth. Crash recovery links existing source journals when present.

Controlled failure injection uses application-layer simulate hooks in `atomic-rpc.ts` for acceptance tests (lost-response semantics after successful RPC commit).

## Application deliverables

- Payroll hub and workflows (`/app/accounting/payroll/*`)
- Labor reports (`/app/reports/labor-by-job`, `labor-by-worker`, `unallocated-labor`)
- Provider-neutral import normalizer + canonical preview
- Payroll recognition, reversal, liability settlement services
- Phase 7 job profitability integration: `directLaborCost`, `employerLaborBurden`, `totalLaborCost`
- Phase 5 banking: payroll clearing/tax withdrawal match, combined provider withdrawal, reconciliation
- Phase 9 close readiness payroll findings
- Phase 10 accountant package payroll/labor sections
- HFAC hard refusal boundary (optional future technician/time sync only)
- Controlled harness: `setup:phase12-demo-org`, `verify:phase12:controlled`, `demo:phase12:controlled`, `accept:phase12:controlled`

## Accounting model

- **Gross wages** → wage expense (debit); withholdings + net pay + employer liabilities → credits
- **Employer payroll tax** → expense debit + FICA/other employer liability credits (split mapping)
- **Employee withholding** → liability credits only (not employer burden)
- **Payroll clearing** → net pay liability; settled Dr clearing / Cr cash (no duplicate wage expense)
- **Direct labor** → job-attributed wage lines + eligible employer burden on jobs
- **Indirect / unallocated labor** → expense without job or flagged unallocated
- **Salaried allocation** → burden rules via labor allocation engine
- **Settlement** → liability relief + cash only (never duplicate recognition expense)
- **Reversal** → mirrors recognition; at most one reversal journal per posted run
- **Period locks** → respected via existing `teller_books_closed_through`

## Concurrency invariants (verified)

| Invariant | Result |
|-----------|--------|
| `PAYROLL_POST_AT_MOST_ONCE_JOURNAL` | true |
| `PAYROLL_REVERSAL_AT_MOST_ONCE_JOURNAL` | true |
| `LIABILITY_SETTLEMENT_AT_MOST_ONCE_JOURNAL` | true |
| `ORPHAN_PAYROLL_JOURNALS` | 0 |
| `CONCURRENT_LOSER_CREATES_JOURNAL` | false |
| `BEST_EFFORT_ORPHAN_REVERSAL_REMOVED` | true |

## Phase 12 demo org

- **Name:** Teller Phase 12 Demo  
- **ID:** `c1cd9cb4-6ea1-4fd4-b4f6-c94c5a5bfd96`  
- **Foreign test org:** `62d7e9d0-6da9-4814-b6a0-da831210d930`  
- All Phase 12 DB acceptance mutates the demo org only — never HFAC or other phase demo orgs.

## Privacy boundary

Teller does **not** store SSN, employee bank credentials, routing numbers, DOB, home address, medical benefit data, or tax elections. Schema privacy tests reject sensitive fields in worker metadata.

## Acceptance snapshots

- Pre-deploy: `artifacts/controlled-prod-snapshots/pre-phase12-deploy-*.json`
- Post-deploy: `artifacts/controlled-prod-snapshots/post-phase12-deploy-*.json`

## Deferred (not blocking Phase 12)

- **Production scheduler/cron** — `PRODUCTION_SCHEDULER_ENABLED` remains false; no Vercel cron configured
- **pg_catalog deep verification** — requires `SUPABASE_DB_URL` (not configured)
- **HFAC payroll sync** — boundary stub only; no HFAC mutation

## Flags

```
PHASE_12_COMPLETE = true
PRODUCTION_DEPLOYED = true
PRODUCTION_SCHEDULER_ENABLED = false
PHASE_13_STARTED = false
```
