# Teller Launch Support Runbook

**LAUNCH_SUPPORT_RUNBOOK = COMPLETE**

First-line guidance for operators supporting early production users.

## Escalation path

1. Reproduce with tenant org ID (never share service role keys)
2. Check `/api/ready` and Vercel deployment status
3. Run read-only verify: `TELLER_CONTROLLED_PROD_TEST=1 npm run verify:phase17h:production`
4. SEV-1 (data exposure, unbalanced journals) → stop releases, invoke `docs/INCIDENT-RESPONSE.md`

---

## Login / access

| Symptom | Check | Action |
|---------|-------|--------|
| Cannot sign in | Supabase auth, Vercel env vars | Verify `NEXT_PUBLIC_SUPABASE_*` on deployment |
| Wrong organization | Session org membership | Confirm user in `teller_organization_members` |
| Restricted entity user blocked | Entity membership | Expected — verify entity assignment |

## Bank connection / sync

| Symptom | Check | Action |
|---------|-------|--------|
| Transactions not importing | Bank feed status | Re-auth connection; check ingest logs |
| Duplicate bank post | Match status | Verify payment already posted; unmatch if duplicate |
| Transfer rejected | Entity on accounts | Both accounts must belong to same legal entity |

## Invoice / payment

| Symptom | Check | Action |
|---------|-------|--------|
| Cannot post invoice | Period closed | Reopen period or post in open period |
| Payment over-allocation | Remaining balance | Partial payment only up to remaining |
| Deposit won't apply | Unapplied deposit balance | Verify deposit liability; check overapplication guard |
| AR aging mismatch | Authoritative remaining | Re-run reports; 17F fix uses subledger remaining |

## HFAC sync

| Symptom | Check | Action |
|---------|-------|--------|
| Event failed | `teller_hfac_webhook_events` status | Inspect error; retry from HFAC if idempotent |
| Duplicate HFAC post | Event ID | Idempotency should prevent; reverse if duplicate confirmed |
| Wrong org mapping | HFAC org mapping config | Never trust client-supplied org ID on webhooks |

## Report mismatch

| Symptom | Check | Action |
|---------|-------|--------|
| TB doesn't balance | Unbalanced journals | SEV-1 — run production journal audit |
| AR/AP vs GL | Control reconciliation | Compare subledger to control accounts |
| Consolidated wrong entity | Company context | Confirm entity filter; eliminations separate |

## Closed period

| Symptom | Check | Action |
|---------|-------|--------|
| Post rejected | Books closed through date | Post in open period or authorized reopen |
| Entity A closed, B open | Entity isolation | Expected — close is per entity |

## Suspected duplicate

1. Find idempotency key / HFAC event ID / payment external ID
2. Compare journal entries linked to economic event
3. Reverse duplicate via supported reversal path — never edit journal lines

## Accounting integrity concern

1. `TELLER_CONTROLLED_PROD_TEST=1 npm run verify:recovery:integrity`
2. Export audit events for affected org (paginated API)
3. Do **not** manually edit posted journals in production
