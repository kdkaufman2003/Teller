# Teller Incident Response Plan

**INCIDENT_RESPONSE_PLAN = COMPLETE**

---

## Severity levels

| Level | Examples | Response time target |
|-------|----------|---------------------|
| **SEV-1** | Cross-tenant data exposure; unbalanced production journals; mass duplicate posting; production data loss; compromised secrets | Immediate — stop releases |
| **SEV-2** | HFAC failure spike; DB unavailable; AR/AP widespread mismatch; broken integration | < 1 hour |
| **SEV-3** | Single-tenant report discrepancy; deployment failure; stale HFAC pending | < 4 hours |
| **SEV-4** | Cosmetic UI; non-blocking performance | Next business day |

---

## Response workflow

1. **Detect** — monitoring, customer report, verify script failure  
2. **Triage** — assign SEV, incident commander  
3. **Contain** — disable feature flag, block webhook, rollback app if needed  
4. **Preserve evidence** — export audit rows, HFAC events, Vercel logs (no secrets)  
5. **Assess customer impact** — tenant list, data scope  
6. **Recover** — per runbook below; never edit posted journals manually  
7. **Verify** — `verify-recovery-integrity.mjs`, journal balance, HFAC baseline  
8. **Postmortem** — blameless write-up within 5 business days for SEV-1/2  

---

## Accounting incident runbook

**ACCOUNTING_INCIDENT_RUNBOOK = COMPLETE**

| Scenario | Procedure |
|----------|-----------|
| Unbalanced journal | SEV-1 — identify entry IDs; post reversal if erroneous; never edit lines |
| Duplicate payment | Identify idempotency key / economic event; reverse duplicate; check 17C constraints |
| Duplicate journal | Same — reversal journal; investigate source API retry |
| Incorrect period close | Reopen period (audited) if policy allows; repost corrections in open period |
| AR/AP mismatch | Run subledger reconciliation; trace payment allocations |
| Inventory/GRNI mismatch | Trace receipt/bill linkage; no quantity cache override |
| HFAC duplicate event | Check `teller_hfac_webhook_events` lifecycle; mark failed; safe replay if idempotent |
| Intercompany partial state | Complete or reverse settlement pair; check entity scope |
| Report discrepancy | Compare TB/GL source; verify entity filter; no aggregation shortcut |

---

## Security incident runbook

**SECURITY_INCIDENT_RUNBOOK = COMPLETE**

| Scenario | Procedure |
|----------|-----------|
| Service role key exposure | SEV-1 — rotate Supabase service role immediately; redeploy Vercel env; audit access logs |
| HFAC webhook secret exposure | Rotate `TELLER_HFAC_WEBHOOK_SECRET`; coordinate HFAC side |
| Session compromise | Force sign-out affected users; review audit for anomalous actions |
| Cross-org access | SEV-1 — disable affected route; review RLS; patch forward |
| Unauthorized entity access | Review entity membership; check 17B-010 documented gaps |

---

## Secret rotation runbook

**SECRET_ROTATION_RUNBOOK = COMPLETE**

| Secret | Location | Rotation steps |
|--------|----------|----------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env, local | Supabase → Settings → API → regenerate; update Vercel; redeploy |
| `TELLER_HFAC_WEBHOOK_SECRET` | Vercel env | Generate new; update HFAC + Vercel; test webhook |
| `TELLER_OPS_STATUS_TOKEN` | Vercel env | Generate new random token; update monitoring |
| Bank provider credentials | Vercel env | Provider dashboard + Vercel update |

Do not rotate live secrets during routine development. Schedule maintenance window.

---

## Vendor outage runbooks

### Supabase outage

**SUPABASE_OUTAGE_RUNBOOK = COMPLETE**

- **What fails:** All reads/writes; auth may fail  
- **Do not:** Attempt manual SQL against production; do not disable RLS  
- **Recovery:** Wait for provider; run `verify-recovery-integrity`; check journal balance  

### Vercel outage

**VERCEL_OUTAGE_RUNBOOK = COMPLETE**

- **What fails:** UI/API only  
- **Accounting:** Database remains intact  
- **Recovery:** Redeploy when platform returns; smoke `/api/ready`  

### HFAC outage

**HFAC_OUTAGE_RUNBOOK = COMPLETE**

- Teller remains standalone functional  
- Webhooks queue as `pending`/`failed` in `teller_hfac_webhook_events`  
- Replay idempotent events after recovery  
- Monitor via `/api/ops/status`  

### Bank provider outage

**BANK_PROVIDER_OUTAGE_RUNBOOK = DOCUMENTED**

- Sync delays; existing books unchanged  
- Use CSV import if urgent  
- Do not fabricate bank transactions  

---

## Operational error taxonomy

**OPERATIONAL_ERROR_TAXONOMY = DOCUMENTED**

`ACCOUNTING_INTEGRITY` · `SECURITY` · `INTEGRATION` · `DATABASE` · `APPLICATION` · `PERFORMANCE` · `SCHEDULED_JOB` · `USER_VALIDATION`

---

## Operator checklists

**OPERATOR_CHECKLIST = COMPLETE**

### Daily

- [ ] `/api/ready` OK  
- [ ] HFAC failed count (ops/status or SQL)  
- [ ] Vercel deployment status — no failed prod build  

### Weekly

- [ ] Supabase backup visible in dashboard  
- [ ] Scheduler run history if enabled  
- [ ] Review failed HFAC `last_error` samples  

### Monthly

- [ ] Access review (admins, service credentials)  
- [ ] Accounting integrity sample (`verify-recovery-integrity`)  
- [ ] Dependency/security updates triage  
- [ ] Backup validation cadence check  

**ACCESS_REVIEW_PROCEDURE = DOCUMENTED** — review org owners, entity memberships, integration keys quarterly.
