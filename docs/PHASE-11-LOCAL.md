# Phase 11 — Subledger automation (local implementation)

**Status:** Local only — migration 027 **not applied**, production **not deployed**.

## Scope

- Prepaid expense schedules (straight-line monthly, cent rounding in final period)
- Accrued expense schedules (optional auto-reversal flag; distinct from AP)
- Deferred revenue schedules (V1: recognize from customer **deposit liability**, not invoice revenue)
- Recurring journal auto-post modes (`draft_only`, `generate_for_review`, `auto_post`)
- Recurring bill generation runs with idempotency
- Close readiness integration for due/failed occurrences
- Schedule attachments/notes metadata tables
- Schedule-to-GL rollforward reconciliation helpers
- Controlled harness: **105/105** scenarios (logic + migration compat; no DB migration required)

## Manual step required

Apply **`supabase/migrations/027_phase11_subledger_automation.sql`** in Supabase SQL Editor before production Phase 11 acceptance.

## Deferred revenue V1 limitation

Customer deposits (Phase 3) remain the upfront receipt path. Schedule-based recognition draws down **deposit liability** (`subtype deposit` / code 2300) — it does **not** re-post cash or double-count applied deposits.

## Scripts

```bash
npm run setup:phase11-demo-org      # after migration 027
npm run verify:phase11:controlled
npm run demo:phase11:controlled     # 105/105 logic matrix
npm run audit:phase11:deployment-compat
```

## Unresolved / Phase 11.1

- Vercel cron for `processDueScheduleOccurrences` (architecture ready; not enabled)
- Full schedule create/edit UI composer
- Accrual settlement workflow when actual bill arrives (manual linking in V1)
- Separate deferred revenue liability account distinct from customer deposits (optional COA enhancement)
