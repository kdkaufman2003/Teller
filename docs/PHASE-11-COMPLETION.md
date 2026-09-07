# Phase 11 — Subledger automation (production complete)

**Completed:** 2026-09-07  
**Migration:** `027_phase11_subledger_automation.sql` (manually applied in Supabase SQL Editor)  
**Production deploy:** `https://teller-indol.vercel.app`  
**Git commit (application):** `c91a9cf`  
**Deployment ID:** `dpl_8ueLU88MWAW2nJbLzqd8YAcUQ7tC`

## Gates

| Gate | Result |
|------|--------|
| Migration 027 verified (REST) | PASS — schedule tables, occurrence tables, recurring bill runs, RLS-queryable |
| Phase 11 controlled logic matrix | **105/105** |
| Phase 11 DB acceptance (demo org only) | **19/19** |
| Deployment compat audit | PASS |
| Phase 5–10 regressions (pre-deploy) | 18/18, 32/32, 45/45, 67/67, 102/102, 110/110 |
| Local unit tests | **473/473** |
| HFAC baseline unchanged | 8 docs, 3 payments, 3 allocations, 16 journals, AR $1,500 |
| Production journals balanced | 0 unbalanced (HFAC spot-check) |
| Production smoke test | PASS (no 5xx; auth routes 307/401 as expected) |
| Post-deploy controlled re-run | 105/105 logic, 19/19 DB, HFAC unchanged |

## Schema (migration 027)

- `teller_org_automation_settings` — privileged auto-post toggles
- `teller_accounting_schedules` — prepaid, accrual, deferred revenue
- `teller_schedule_occurrences` — durable idempotency per schedule + date
- `teller_schedule_attachments`, `teller_schedule_notes` — metadata
- `teller_recurring_bill_runs` — recurring bill generation history
- Recurring journal `post_mode` + `auto_post_enabled`; recurring bill template enhancements
- RLS on all new tables via `teller_is_org_member` / `teller_can_write_books`
- **Unchanged:** `teller_post_journal` signature; Phase 9 close; Phase 10 reporting

## Application deliverables

- Schedules hub with summary cards (`/app/accounting/schedules`)
- Prepaid, accrual, and deferred revenue composers with activation preview
- Schedule detail, draft edit, lifecycle (activate/pause/resume/cancel)
- Occurrence review workflow (approve/post/skip/retry/reverse)
- Close readiness deep links to schedule occurrences
- Schedule-to-GL rollforward reconciliation helpers
- Controlled harness: `setup:phase11-demo-org`, `verify:phase11:controlled`, `demo:phase11:controlled`, `accept:phase11:controlled`

## Phase 11 demo org

- **Name:** Teller Phase 11 Demo  
- **ID:** `f88419a9-1397-46b8-9c5f-ad799307c496`  
- All Phase 11 DB acceptance mutates this org only — never HFAC or other phase demo orgs.

## Acceptance snapshots

- Pre: `artifacts/controlled-prod-snapshots/pre-phase11-2026-09-07T18-39-50-068Z.json`
- Post: `artifacts/controlled-prod-snapshots/post-phase11-acceptance-2026-09-07T18-48-00-255Z.json`

## Deferred (not blocking Phase 11)

- **Production scheduler/cron** — `PRODUCTION_SCHEDULER_CRON` deferred until separately authorized; manual occurrence workflows sufficient for V1
- **Accrual-to-bill automatic settlement** — Phase 11.1; accruals post journals only, not AP bills
- **Deferred revenue deposit-linked E2E in demo org** — validation guards verified; full Phase 3 deposit → schedule fixture optional
- **pg_catalog deep verification** — `SUPABASE_DB_URL` not configured; REST table/column probes used instead

## Deferred revenue V1 limitation

Customer deposits (Phase 3) remain the upfront receipt path. Schedule-based recognition draws down **deposit liability** (code 2300) — it does not re-post cash or double-count applied deposits. Invoice revenue remains distinct.

## Flags

```
PHASE_11_COMPLETE = true
PHASE_11_1_STARTED = false
PHASE_12_STARTED = false
PRODUCTION_SCHEDULER_ENABLED = false
```
