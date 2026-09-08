# Phase 14 Implementation — 14A Budget Foundation

**Slice:** 14A · **Status:** Complete · **DB verified:** yes (2026-09-08)

> **Permanent rule:** ALL Teller Supabase migrations and SQL patches are manually applied by the operator.

---

## 14A scope (implemented)

| Area | Status |
|------|--------|
| Migration 032 source | Applied manually by operator |
| Planning settings (`teller_planning_settings`) | API + DB verified |
| Budget header / versions / lines | Domain + API + DB verified |
| Draft editing + bulk upsert | Budget editor UI |
| Approved / locked immutability | App + DB triggers verified |
| Version clone / revision | RPC + manual fallback verified |
| Planning audit events | DB verified |
| Owner-friendly UI | `/app/planning/*` |

## Deferred (14B+)

- Prior-year actual baseline import
- CSV import/export
- Budget vs actual reporting
- Forecasting, cash planning, scenarios
- Full controlled demo runner (14K scale)
- Production deployment

---

## Migration 032 status

| Item | Value |
|------|-------|
| `MIGRATION_032_CREATED` | true |
| `MIGRATION_032_MANUALLY_APPLIED` | true |
| `MIGRATION_032_OBJECT_VERIFY` | PASS |
| `TELLER_POST_JOURNAL_CHANGED` | false |
| `PHASE_14A_DB_VERIFIED` | true |

**File:** `supabase/migrations/032_phase14_planning.sql`

---

## DB verification results (Phase 14A closeout)

**Harness:** `npm run accept:phase14:controlled` — **21/21 PASS**

| Gate | Result |
|------|--------|
| Planning settings CRUD | PASS |
| Budget persistence + audit | PASS |
| Monthly lines + exact cents totals | PASS |
| Duplicate line protection (DB unique) | PASS |
| Foreign GL account rejection (trigger) | PASS |
| Draft editing | PASS |
| Approved version immutability | PASS |
| Locked version immutability | PASS |
| Invalid lifecycle transitions (domain) | PASS |
| Revision clone (RPC schema + manual path) | PASS |
| Cross-tenant read/write isolation | PASS |
| IDOR protection | PASS |
| Planning journals created | 0 |
| HFAC baseline unchanged | PASS |
| Orphan planning records | 0 |

**Demo orgs:** `Teller Phase 14 Demo`, `Teller Phase 14 Foreign Test`  
**Setup:** `npm run setup:phase14-demo-org`  
**Object verify:** `npm run verify:migration:032:controlled`

### Notes from verification

- Approve/lock/clone RPCs require authenticated org writer (`auth.uid()`); service role receives expected authorization rejection. Immutability tests set version status directly; production UI uses session-authenticated API routes.
- PostgREST requires non-null `p_actor_id` UUID for clone RPC discovery (empty string fails schema cache lookup).
- Test cleanup must reset version status to `draft` before deleting lines (immutability triggers block CASCADE deletes on locked versions).

---

## Schema summary

| Table | Purpose |
|-------|---------|
| `teller_planning_settings` | Org defaults (AR/AP days, horizon, payroll cadence) |
| `teller_budgets` | Annual budget container per org × fiscal year |
| `teller_budget_versions` | draft → submitted → approved → locked → archived |
| `teller_budget_lines` | account × month amounts (numeric 14,2) |
| `teller_planning_audit_events` | Planning lifecycle audit |
| `teller_forecasts` / `teller_forecast_versions` | Schema-only foundation |

**Accounting boundary:** Planning code does not call `teller_post_journal`. Budget lines are planning truth only.

---

## Application architecture

```
src/lib/planning/
  budgets/     — lifecycle, validation, totals, budget-crud, audit
  settings/    — planning-settings defaults/parser
  presentation-labels.ts

src/app/api/planning/
  settings/
  budgets/ … versions/ … lifecycle/

src/app/app/planning/
  page.tsx              — hub
  budgets/              — list, new, [id] editor
```

---

## Tests

```bash
npm run test:fast                              # includes phase14.test.ts
TELLER_TEST_PHASE=14 npm run test:phase        # unit + migration object verify
npm run verify:migration:032:controlled        # applied DB object gate
npm run accept:phase14:controlled              # 21-scenario DB acceptance
```

---

## Phase 14A close gate

```
PHASE_14A_CODE_COMPLETE = true
PHASE_14A_DB_VERIFIED = true
PHASE_14A_COMPLETE = true
PHASE_14_COMPLETE = false
PHASE_14B_STARTED = false
```
