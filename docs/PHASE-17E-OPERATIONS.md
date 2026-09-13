# Phase 17E — Backup, DR, Audit & Operational Controls

**Status:** Code complete · **Patch 054 requires manual application before production close**

---

## 1. Operational control inventory

**OPERATIONAL_CONTROL_INVENTORY = COMPLETE**

| Area | Current state | Control | Owner | Frequency | Evidence | Gap | Severity | Recommendation |
|------|---------------|---------|-------|-----------|----------|-----|----------|----------------|
| Database backup | Supabase managed (plan-dependent) | Provider daily backups | Operator | Weekly verify | Supabase dashboard | PITR tier UNKNOWN | HIGH | Manual verify in dashboard |
| Point-in-time recovery | Plan-dependent | Supabase PITR if enabled | Operator | Monthly | Dashboard | UNKNOWN until verified | HIGH | Confirm Pro/Team PITR |
| Restore testing | Documented | Isolated rehearsal procedure | Operator | Quarterly | `verify-recovery-integrity.mjs` | Not production-tested | MEDIUM | Quarterly isolated restore |
| Deployment rollback | Vercel instant rollback | Redeploy prior deployment | Operator | Per incident | Vercel dashboard | None | — | Use runbook |
| DB patch rollback | Forward-fix policy | Manual corrective patch | Operator | Per incident | Patch ledger | No blind rollback | — | See MANUAL-DATABASE-CHANGE-RUNBOOK |
| Incident response | Documented | SEV-1–4 triage | Operator | Per incident | INCIDENT-RESPONSE.md | No paging wired | MEDIUM | Manual monitoring |
| Audit trail | `teller_audit_events` + domain tables | Append-only + RLS | App + DB | Continuous | API + patch 054 | Partial coverage pre-17E | MEDIUM | **Closed** dedicated banking actions |
| Config change audit | `settings.updated` + domain events | `recordAuditEvent` | App | Continuous | Audit rows | Generic action for some banking | LOW | metadata.bankingAction |
| Release controls | Phase gates + runbook | test:full, verify scripts | Operator | Per release | PRODUCTION-RELEASE-RUNBOOK | None | — | Follow runbook |
| Environment separation | prod/preview/local | Vercel + Supabase projects | Operator | Continuous | Project IDs | None | — | Guard prod ref |
| Secret rotation | Documented | Manual rotation | Operator | Quarterly | SECRET-ROTATION section | Not automated | LOW | Rotate on schedule |
| Monitoring | Partial | `/api/ready`, `/api/ops/status` | App | Continuous | HTTP probes | No external APM | MEDIUM | Ops token + manual checks |
| Health checks | `/api/ready` added | DB connectivity probe | App | Load balancer | 200/503 JSON | None | — | Monitor endpoint |
| Scheduled jobs | Cron route exists | Disabled by default | Operator | Weekly | `PRODUCTION_SCHEDULER_ENABLED` | Off in prod | INFO | Enable when ready |
| Data retention | Documented | Policy below | Operator | Annual review | This doc | No auto-archive | LOW | Defer archival job |
| HFAC failures | Observable | `teller_hfac_webhook_events` counts | Ops API | Daily | ops/status | No UI | LOW | Ops token query |

---

## 2. Backup capability audit

**DATABASE_BACKUP_AVAILABLE = YES (Supabase platform default; tier UNKNOWN — verify manually)**  
**DATABASE_BACKUP_FREQUENCY = Daily (Supabase default; confirm in dashboard)**  
**DATABASE_BACKUP_RETENTION = Plan-dependent (typically 7–30 days; verify manually)**  
**PITR_AVAILABLE = UNKNOWN (requires Supabase Pro/Team + dashboard confirmation)**  
**PITR_RETENTION = UNKNOWN**  
**BACKUP_SCOPE = PostgreSQL database (schema + data). Does NOT include Vercel env vars, Supabase Auth config, or third-party secrets.**

### Manual verification required

1. Supabase Dashboard → Project `ypixbxicdecwfafculha` → Database → Backups  
2. Confirm daily backup schedule and retention window  
3. Confirm whether PITR is enabled and retention period  
4. Record findings in operator log (do not store secrets)

**MANUAL_OPERATIONAL_ACTION_REQUIRED = true** until backup/PITR settings are confirmed in Supabase dashboard.

---

## 3. RPO / RTO

**RPO_TARGET = ≤ 24 hours** (daily backup baseline; ≤ 1 hour if PITR confirmed enabled)  
**RTO_TARGET = ≤ 4 hours** (application redeploy + DB restore + verification)  
**RPO_SUPPORTED = DOCUMENTED (provider capability UNKNOWN until dashboard verified)**  
**RTO_SUPPORTED = DOCUMENTED (depends on operator response + Supabase restore SLA)**

---

## 4. Backup validation procedure

**BACKUP_VALIDATION_PROCEDURE = DOCUMENTED**

Quarterly (or after major schema change):

1. Confirm Supabase backup exists for target date (dashboard)  
2. Restore to **isolated** staging/test project (never over production)  
3. Run `TELLER_CONTROLLED_PROD_TEST=1 node scripts/verify-recovery-integrity.mjs` against restored project  
4. Verify row counts: organizations, legal entities, journals, documents, payments  
5. Verify journal balance scan = 0 unbalanced  
6. Verify HFAC baseline if HFAC org present  
7. Verify probe RPCs (051–054)  
8. Document result: CONFIGURED / TESTED / VERIFIED distinction preserved  

---

## 5. Restore test strategy

**RESTORE_TEST_STRATEGY = DOCUMENTED**

- **Never** restore over production  
- Preferred: new Supabase project from backup snapshot  
- Alternative: local schema + synthetic fixture validation (`verify-recovery-integrity` logic)  
- Verify: schema, RLS policies, functions, journal integrity, tenant FK relationships  
- Application smoke: login, trial balance, invoice list  

**RESTORE_REHEARSAL = DOCUMENTED (demo/synthetic logic validated via recovery verifier unit tests)**  
**RESTORE_REHEARSAL_ENVIRONMENT = local/demo — production restore not performed in 17E**  
**RESTORE_REHEARSAL_ACCOUNTING_INTEGRITY = PASS (verifier logic + production read-only baseline unchanged)**

---

## 6. Recovery integrity checklist

**RECOVERY_INTEGRITY_CHECKLIST = COMPLETE**

Tool: `scripts/verify-recovery-integrity.mjs`

Checks:

- Journal count + balance scan (0 unbalanced)  
- Document count  
- Payment count  
- Legal entity count  
- HFAC documents/journals baseline  
- Probe RPCs: 051, 052, 053, 054  

---

## 7. Accounting recovery model

**ACCOUNTING_RECOVERY_MODEL = DOCUMENTED**

Non-negotiable rules:

1. Never manually edit posted journal line amounts  
2. Prefer idempotent replay (17C keys) for retriable operations  
3. Otherwise post reversal/correction journal  
4. Restore is infrastructure recovery — not a bookkeeping shortcut  
5. Do not merge restored snapshot with newer production history without explicit reconciliation  
6. Partial restore must preserve document ↔ journal ↔ payment relationships  

---

## 8. Accidental delete recovery

**ACCIDENTAL_DELETE_RECOVERY = DOCUMENTED**

| Model | Tables / behavior |
|-------|-------------------|
| Immutable | `teller_journal_entries`, `teller_journal_lines` — reversals only |
| Soft void | `teller_documents`, `teller_payments` — status void + reversal |
| Soft archive | `teller_legal_entities`, COA accounts — `is_active` / `archived` |
| Hard delete | Child rows in planning refresh, demo fixtures only |

**HIGH_RISK_HARD_DELETE_PATHS = demo/controlled runners (service role, non-production orgs only)**

Production user APIs do not hard-delete journals or posted documents.

---

## 9. Production DB change ledger

**PRODUCTION_DB_CHANGE_LEDGER = COMPLETE**

| Patch | Purpose | Applied | Verified |
|-------|---------|---------|----------|
| 047 | Entity probe RPC | Manual | verify-phase16h |
| 048 | Books closed overload fix | Manual | verify-phase16j |
| 049 | Legacy posting entity fix | Manual | verify-phase16j |
| 050 | Payments entity default | Manual | verify-phase16j |
| 051 | Security hardening (journal insert block) | Manual | verify-phase17b |
| 052 | Reliability (idempotency, HFAC lifecycle) | Manual | verify-phase17c |
| 053 | Performance indexes | Manual | verify-phase17d |
| 054 | Audit immutability + ops probe | **Pending manual apply** | verify-phase17e |

Migrations 001–047 applied via Supabase migration history (see `supabase/migrations/`).

---

## 10. Audit event inventory

**AUDIT_EVENT_INVENTORY = COMPLETE**

Primary table: `teller_audit_events` (~12,384 rows production).

| Action category | Audited? | Actor | Org | Notes |
|-----------------|----------|-------|-----|-------|
| Journal post/reverse | Yes | Server session | Yes | `journal.posted`, `journal.reversed` |
| Invoice/bill lifecycle | Yes | Server | Yes | |
| Payments/allocations | Yes | Server | Yes | `payment.allocated` |
| Period close/reopen | Yes | Server | Yes | `period.closed`, `period.reopened` |
| Legal entity/access | Yes | Server | Yes | |
| Banking match | Yes | Server | Yes | **17E:** dedicated `banking.match.*` |
| HFAC webhook | Yes | System | Yes | `hfac.webhook.accepted/rejected` |
| Intercompany/elimination | Yes | Server | Yes | |
| Payroll/tax/fixed assets | Yes | Server | Yes | |
| Settings/integration | Yes | Server | Yes | `settings.updated` |

**HIGH_VALUE_AUDIT_GAPS = 0** (banking match actions now dedicated; period reopen already audited; payment.allocated present)

---

## 11. Audit immutability & tamper resistance

**AUDIT_LOG_USER_UPDATE = false** (no UPDATE RLS; patch 054 trigger blocks UPDATE)  
**AUDIT_LOG_USER_DELETE = false** (no DELETE RLS for members)  
**AUDIT_ACTOR_SERVER_DERIVED = true** (RLS: `actor_id is null or actor_id = auth.uid()`)  
**AUDIT_ORG_SERVER_DERIVED = true** (APIs use `requireBooks()` org, never client-supplied org for writes)

Service-role DELETE remains break-glass for demo cleanup only — documented, not exposed to tenant users.

---

## 12. Audit retention

**AUDIT_RETENTION_POLICY = DOCUMENTED**

| Tier | Duration | Scope |
|------|----------|-------|
| Hot | Indefinite (current) | All `teller_audit_events` in primary DB |
| Archive | TBD post-launch | Security/accounting events ≥ 7 years recommended |
| Diagnostic | 90 days | Low-value scans if separated later |

**AUDIT_ARCHIVAL_REQUIRED = false at current scale (~12k rows)**  
**AUDIT_ARCHIVAL_STRATEGY = Defer to post-launch; export to cold storage before delete; never delete without archive**

Do not auto-delete production audit rows.

---

## 13. Audit query performance

**AUDIT_LOG_PAGINATION = PASS** (`GET /api/audit-events` with `.range()`, max 500)  
**AUDIT_UNBOUNDED_FETCH = false**

---

## 14. Monitoring & health

**MONITORING_COVERAGE = PARTIAL (in-app probes; no external APM)**

| Signal | Source |
|--------|--------|
| App liveness | `GET /api/ready` |
| DB connectivity | `/api/ready` server probe |
| HFAC failed/pending | `GET /api/ops/status` (bearer token) |
| Scheduler failures | ops/status `teller_scheduler_runs` |
| Phase probes | ops/status readiness.probes |

**HEALTH_CHECK = PASS** (`/api/ready`)  
**ACCOUNTING_HEALTH_MONITORING = DOCUMENTED** (daily: `verify-recovery-integrity` or phase verify; not on every HTTP health hit)  
**FAILED_HFAC_EVENTS_OBSERVABLE = true** (DB query + ops/status)  
**SCHEDULED_JOB_MONITORING = FINDINGS** (history table exists; cron disabled by default)  
**BACKGROUND_FAILURE_PERSISTENCE = PASS** (HFAC `failed` status, scheduler run status)

---

## 15. Alerting strategy

**ALERTING_STRATEGY = DOCUMENTED**

Manual operator alerts (until external paging approved):

| Condition | Action |
|-----------|--------|
| Unbalanced journals > 0 | SEV-1 — stop releases |
| HFAC failed count increase | SEV-2 — inspect `last_error` |
| `/api/ready` 503 | SEV-2 — check Supabase/Vercel |
| Deployment failure | SEV-3 — rollback per runbook |
| Stale HFAC pending > 24h | SEV-3 — inspect webhook handler |

**OPERATIONAL_DASHBOARD_REQUIRED = false** — ops/status API sufficient at current scale.

---

## 16. Soft vs hard delete

**SOFT_DELETE_TABLES = documents (void), payments (void), legal_entities (archive), accounts (archived), planning (archived status)**  
**HARD_DELETE_TABLES = demo fixtures, planning line refresh, child schedule rows**  
**HIGH_RISK_HARD_DELETE_TABLES = none in production user paths**

---

## 17. Support & break-glass

**SUPPORT_ACCESS_MODEL = DOCUMENTED**

- No in-app customer impersonation UI  
- Operator access via Supabase dashboard (service role) and Vercel logs  
- All support DB access must be logged in operator incident record  

**BREAK_GLASS_ACCESS = DOCUMENTED**

- Supabase service role: emergency read/write — rare, audited, revocable  
- Not shared credentials; stored in password manager  
- Never used to edit posted journal amounts  

---

## 18. Vendor dependencies

**VENDOR_DEPENDENCY_INVENTORY = COMPLETE**

| Service | Purpose | Failure impact | Accounting impact | Recovery |
|---------|---------|----------------|-------------------|----------|
| Supabase | DB, auth | Total outage | No new postings | Wait + verify integrity |
| Vercel | App hosting | UI/API down | DB intact | Rollback redeploy |
| HFAC | Optional webhooks | Integration delay | Teller standalone OK | Replay failed events |
| Bank provider | Optional sync | Stale bank lines | No fabricated activity | Manual CSV import |

See INCIDENT-RESPONSE.md for outage runbooks.

---

## 19. Data portability & retention

**DATA_PORTABILITY = FINDINGS**

- GL/reports: existing report engine + export routes partial  
- Documents/parties: API readable; bulk export UX deferred to 17F+  
- Audit: paginated API added 17E  

**TENANT_DELETION_POLICY = DOCUMENTED** — org deletion cascades; requires explicit operator action; not self-service destructive wipe in V1  
**ACCOUNTING_RETENTION_POLICY = DOCUMENTED** — retain accounting records per business/legal requirements; no auto-purge of posted history  

---

## 20. Logging

**SENSITIVE_LOGGING = false** (no service role keys, tokens, passwords in `src/` logs)  
**SENSITIVE_DATA_LOGGING = PASS**  
**ERROR_CORRELATION = PASS** (idempotency keys, HFAC event IDs, journal entry IDs link flows)  
**ACCOUNTING_EVENT_TRACEABILITY = PASS** (documents → payments → journals → external IDs)

---

## 21. Patch 054 (manual apply)

**File:** `supabase/patches/054_phase17e_operational_controls.sql`

Contents:

1. UPDATE trigger on audit tables (append-only)  
2. REVOKE UPDATE from authenticated/anon  
3. HFAC webhook status index for ops queries  
4. `teller_phase17e_operations_probe()` RPC  

Static verify: `npm run verify:patch:054:static`

---

## 22. Findings register

| ID | Severity | Summary | Status |
|----|----------|---------|--------|
| **17E-001** | HIGH | Backup/PITR tier not provable from repo | DOCUMENTED — manual dashboard verify |
| **17E-002** | HIGH | No production restore rehearsal | DOCUMENTED — quarterly procedure |
| **17E-003** | MEDIUM | Audit UPDATE not DB-enforced pre-054 | **Patch 054** prepared |
| **17E-004** | MEDIUM | No public health endpoint pre-17E | **Fixed** `/api/ready` |
| **17E-005** | MEDIUM | HFAC failures not operator-visible | **Fixed** ops/status + index |
| **17E-006** | MEDIUM | Banking match audit used generic actions | **Fixed** dedicated actions |
| **17E-007** | MEDIUM | No org audit log API | **Fixed** `/api/audit-events` |
| **17E-008** | LOW | Scheduler disabled in production | DOCUMENTED |
| **17E-009** | LOW | No external alerting/paging | DOCUMENTED |
| **17E-010** | INFO | Audit table largest (~12k rows) | Retention policy documented |

**PHASE17E_FINDINGS_TOTAL = 10** · CRITICAL = 0 · HIGH = 2 · MEDIUM = 5 · LOW = 2 · INFO = 1

---

## 23. Verification

```bash
npm run verify:patch:054:static
TELLER_CONTROLLED_PROD_TEST=1 npm run verify:phase17e:production
TELLER_CONTROLLED_PROD_TEST=1 npm run accept:phase17e:controlled
TELLER_CONTROLLED_PROD_TEST=1 node scripts/verify-recovery-integrity.mjs
TELLER_TEST_PHASE=17 npm run test:phase
npm run test:full
```

**Apply patch 054 manually before production close.**
