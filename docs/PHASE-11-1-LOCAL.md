# Phase 11.1 — Local implementation (not deployed)

Accrual-to-bill settlement and production scheduler readiness implemented locally only.

## Deferred until manual migration 028

- Apply `supabase/migrations/028_phase11_1_accrual_settlement.sql` manually when authorized
- Do **not** enable `PRODUCTION_SCHEDULER_ENABLED` until separately authorized

## Accounting corrections (pre-migration 028)

- **Bill void guard:** Bills with active accrual settlements cannot be voided until settlement is explicitly reversed.
- **Multi-account variance:** Variance posts per accrual allocation expense account (proportional by default), never to a arbitrary first account.
- **Purchase tax:** Vendor bill tax capitalizes into expense/asset lines; sales-tax-payable is not used for purchase tax in V1.
- **Mixed bills:** Settlement portion, new expense lines, and purchase tax are computed separately; unrelated lines do not distort accrual variance.


When posting a vendor bill, select **Apply existing accrual** to:

1. Debit accrued liability (applied amounts)
2. Debit/credit expense for estimate-to-actual variance only
3. Credit AP for the full bill total

Routes:

- `/app/accounting/accrual-settlements`
- Bill form accrual picker
- APIs under `/api/accounting/accrual-settlements/*`

## Scheduler (disabled)

- Config: `src/lib/accounting/schedules/scheduler-config.ts`
- Run history: `teller_scheduler_runs` (migration 028)
- Cron route: `/api/cron/process-schedules` returns 503 while `PRODUCTION_SCHEDULER_ENABLED=false`
- Recommended cadence when enabled: hourly (`0 * * * *`)

## Local gate

```bash
npm test
npm run build
npm run audit:phase11-1:deployment-compat
npm run demo:phase11-1:controlled
```

## Accounting note — period locks

Settlement posts on the **bill date** (new economic event). A closed accrual period does not block settlement when the bill period is open. A closed bill period rejects settlement unless the period is reopened per Phase 9 workflow.
