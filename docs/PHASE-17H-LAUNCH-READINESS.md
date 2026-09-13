# Phase 17H — Final Launch Readiness

**PHASE_17_SLICE = 17H**  
**TELLER_RELEASE_IDENTIFIER = Phase17-Final**

---

## Launch decision gate

`LAUNCH_DECISION = NOT_READY` until **manual backup/PITR confirmation** is supplied by the operator (see §33 below).

All other automated gates must also pass.

---

## Release candidate

| Field | Value |
|-------|-------|
| Branch | `main` |
| Commit | Set at 17H close — see `FINAL_RELEASE_COMMIT_SHA` |
| Feature freeze | Active |

---

## Production change ledger

| Change | Type | Status |
|--------|------|--------|
| Patch 051 — security hardening | SQL (manual) | Applied & verified |
| Patch 052 — reliability hardening | SQL (manual) | Applied & verified |
| Patch 053 — performance indexes | SQL (manual) | Applied & verified |
| Patch 054 — operational controls | SQL (manual) | Applied & verified |
| Phase 17 application release | Vercel deploy | See deployment record |

**DATABASE_FORWARD_FIX_POLICY = PASS** — no destructive DB rollback SQL.

---

## Unresolved findings review

**PHASE17_UNRESOLVED_FINDINGS_REVIEW = COMPLETE**

| ID | Phase | Severity | Classification | Notes |
|----|-------|----------|----------------|-------|
| 17A-014 | 17A | INFO | TEST_FIXTURE_DEBT | Orphan demo payments on Phase 16 demo org |
| 17B-010 | 17B | MEDIUM | POST_LAUNCH_MEDIUM | Entity RLS gap — documented |
| 17C-001–003 | 17C | HIGH | ACCEPTED_LAUNCH_RISK | Partial commit paths mitigated by idempotency; RPC wrap deferred |
| 17D-007–008 | 17D | MEDIUM | POST_LAUNCH_MEDIUM | SSR full-scan lists — API paginated |
| 17E-001 | 17E | HIGH | **LAUNCH_BLOCKER until confirmed** | Backup/PITR manual dashboard verify |
| 17E-002 | 17E | HIGH | POST_LAUNCH_HIGH | No restore rehearsal — quarterly procedure |
| 17E-008–009 | 17E | LOW | POST_LAUNCH_LOW | Scheduler/alerting |
| 17F-010 | 17F | INFO | POST_LAUNCH_LOW | Bills page title |
| 17G-001 | 17G | INFO | Resolved by 17H deploy | `/api/ready` must be live post-deploy |
| 17G-002 | 17G | INFO | TEST_FIXTURE_DEBT | 5 orphan demo payments — not production |

**UNRESOLVED_LAUNCH_CRITICAL = 0**  
**UNRESOLVED_LAUNCH_HIGH = 1** (17E-001 until operator confirms backup/PITR)

---

## Demo fixture debt

**PHASE16_DEMO_ORPHAN_PAYMENTS** — count from snapshot (expected ~5)  
**DEMO_FIXTURE_DEBT_LAUNCH_BLOCKER = false** — isolated to controlled demo org

---

## Launch supported user profiles

**LAUNCH_SUPPORTED_USER_PROFILES = DOCUMENTED**

- Single-company small business (owner mode)
- Bookkeeper/accountant (accountant mode)
- Multi-entity operator (Company A/B switching, consolidation)
- HVAC / contractor vertical (jobs, inventory, GRNI)
- HFAC-integrated organization (webhook sync — read-only baseline protected)

---

## RPO / RTO (pending operator input)

Documented targets from 17E (supportability depends on verified Supabase tier):

| Metric | Target | Supported |
|--------|--------|-----------|
| RPO | ≤ 24 hours (daily backup) or ≤ minutes (PITR) | **Pending operator confirmation** |
| RTO | ≤ 4 hours application; DB depends on restore path | **Pending operator confirmation** |

---

## First week monitoring plan

**FIRST_WEEK_MONITORING_PLAN = COMPLETE**

Daily (operator):

- [ ] `GET /api/ready` — `ok: true`, `db: connected`
- [ ] Vercel deployment status — no failed production build
- [ ] Failed HFAC webhook events count (ops status or DB)
- [ ] Unbalanced production journals = 0 (`verify-phase17h-production`)
- [ ] Duplicate idempotency keys = 0
- [ ] Auth error rate (Vercel logs — no credential logging)
- [ ] Critical route latency (invoices, banking, reports — subjective smoke)

---

## First month review plan

**FIRST_MONTH_REVIEW_PLAN = COMPLETE**

Weekly:

- Accounting integrity spot-check on largest active org
- HFAC baseline unchanged unless legitimate activity
- Audit sample review (no user mutations)
- Support issue log — defects vs feature requests

Monthly:

- Backup/PITR status reconfirmation
- Access review (admin roles, entity memberships)
- Performance spot-check (dashboard, consolidation)
- Reconciliation anomaly review (AR/AP/deposits)

---

## Rollback

**ROLLBACK_TARGET_IDENTIFIED = true**  
**ROLLBACK_RUNBOOK = PASS** — see `docs/PRODUCTION-RELEASE-RUNBOOK.md`

Previous known-good: last Vercel production deployment before Phase 17H final promote.

---

## Environment separation

**ENVIRONMENT_SEPARATION = PASS**

- `.env*` gitignored
- Controlled prod env in `.env.controlled-prod.local` (not committed)
- Demo orgs isolated from HFAC production org
- `TELLER_CONTROLLED_PROD_TEST=1` required for production DB reads in scripts

---

## Manual operator checkpoint — BACKUP / PITR

**BACKUP_PITR_OPERATOR_CONFIRMATION = REQUIRED**

Cursor cannot read Supabase Dashboard backup settings. The operator must check:

**Supabase Dashboard → Database → Backups**

Report back:

1. Is production database backup **enabled**?
2. **Backup frequency** (e.g. daily)
3. **Backup retention** (e.g. 7 days)
4. Is **PITR enabled**?
5. **PITR retention/window** if enabled (e.g. 7 days)

Until confirmed:

```
BACKUP_CONFIGURATION_VERIFIED = false
PHASE_17H_COMPLETE = false
LAUNCH_DECISION = NOT_READY
```

---

## Run commands

```bash
node scripts/scan-repository-secrets.mjs
TELLER_CONTROLLED_PROD_TEST=1 node scripts/snapshot-phase17h-final.mjs pre
npm run test:fast
TELLER_CONTROLLED_PROD_TEST=1 TELLER_TEST_PHASE=17 npm run test:phase
npm run test:full
npm run build
TELLER_CONTROLLED_PROD_TEST=1 npm run accept:phase17h:controlled
# after deploy:
TELLER_CONTROLLED_PROD_TEST=1 npm run verify:phase17h:production
TELLER_CONTROLLED_PROD_TEST=1 node scripts/snapshot-phase17h-final.mjs post
```
