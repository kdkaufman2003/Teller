# Phase 14 Implementation — Planning

**Slice:** 14A complete · 14B complete · **DB verified:** yes (2026-09-08)

> **Permanent rule:** ALL Teller Supabase migrations and SQL patches are manually applied by the operator.

---

## 14B scope (implemented)

| Area | Status |
|------|--------|
| Budget approval review UX | Review modal with totals, account/month counts, warnings |
| Lock confirmation UX | Deliberate confirm before lock |
| Create Revision UX | Owner label; clone RPC path |
| Prior-year actual baseline | GL `teller_gl_account_totals` per month; P&L only |
| Copy-forward | New draft budget; fiscal-year month shift |
| CSV export | Account Number, Name, Jan–Dec, Annual Total; formula-safe |
| CSV import | Upload → preview → validate → confirm; draft-only |
| Bulk edit tools | Spread annual, copy across, % adjust, clear account |
| Planning audit | `budget_created_from_actuals`, `budget_copied_forward`, `budget_csv_imported` |

### Prior-year actual baseline rules

- **Source:** Phase 10 aggregated GL via `teller_gl_account_totals` (no journal copies).
- **Scope:** Operating P&L accounts only — `revenue`, `cogs`, `expense` (non-archived).
- **Mapping:** Calendar fiscal year — Jan N−1 actual → Jan N budget month (same for all 12 months).
- **Writes:** Planning lines only; `source_kind = actual_baseline`; zero accounting postings.

### Copy-forward rules

- Creates a **new** budget header + draft version 1.
- Shifts each line’s `period_month` by `(targetFY − sourceFY)` years.
- Does **not** copy approval/lock state or audit actors.
- Sets `source_version_id` lineage on the new version when copying from a version.

### CSV format

```text
Account Number,Account Name,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec,Annual Total
```

- Amounts persisted as exact cents (`numeric(14,2)`).
- Annual Total column optional (informational; row validation warns on mismatch).

### Account matching (import)

1. Account Number (exact, case-insensitive)
2. Exact normalized Account Name (when code absent or no code match)

No silent GL account creation. Ambiguous code matches and unknown accounts surface as row errors.

### Import modes (draft versions only)

| Mode | Behavior |
|------|----------|
| **replace** | Upsert all CSV account/month values (empty month cells → 0) |
| **merge** | Upsert non-zero CSV values only; preserve other months |

Approved/locked versions reject import at server (`assertLinesEditable`).

### Security

- Org from session only; batch account resolution; upload size/row limits.
- Exported text fields sanitized against spreadsheet formula injection (`=`, `+`, `-`, `@` prefixes).
- Import filename sanitized; CSV body not stored in audit payload.

### Deferred (14C+)

- Budget vs actual reporting
- Forecasting, cash planning, scenarios
- Production deployment

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

## Deferred (14C+)

- Budget vs actual reporting
- Forecasting, cash planning, scenarios
- Full controlled demo runner (14K scale)
- Production deployment

---

## Migration status

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
npm run test:fast                              # includes phase14 + phase14b tests
TELLER_TEST_PHASE=14 npm run test:phase        # unit + migration object verify
npm run verify:migration:032:controlled        # applied DB object gate
npm run accept:phase14:controlled              # 32-scenario DB acceptance (14A+14B)
```

---

## Phase 14B controlled DB verification (2026-09-08)

**Harness:** `npm run accept:phase14:controlled` — **32/32 PASS**

| Gate | Result |
|------|--------|
| Prior-year GL baseline (month mapping, exact cents) | PASS |
| P&L scope (excludes balance sheet + archived) | PASS |
| Copy-forward (FY shift, draft, lineage) | PASS |
| Revision clone (source immutable, draft editable) | PASS |
| Approval / lock immutability | PASS |
| CSV import (money formats, merge, replace) | PASS |
| CSV export + formula injection protection | PASS |
| Draft-only import (approved/locked rejected) | PASS |
| Bulk budget tools persistence | PASS |
| Phase 14B audit events | PASS |
| Cross-tenant isolation + IDOR | PASS |
| Planning journals created by planning ops | 0 |
| HFAC baseline unchanged | PASS |
| Orphan planning records | 0 |

**Fixture note:** Acceptance clears Phase 14 demo org journals before seeding controlled 2026 GL actuals so prior-year baseline reads are deterministic across re-runs.

---

## Phase 14 close gates

```
PHASE_14A_CODE_COMPLETE = true
PHASE_14A_DB_VERIFIED = true
PHASE_14A_COMPLETE = true
PHASE_14B_CODE_COMPLETE = true
PHASE_14B_DB_VERIFIED = true
PHASE_14B_COMPLETE = true
PHASE_14B_STARTED = true
PHASE_14_COMPLETE = false
PHASE_14C_STARTED = false
MIGRATION_033_REQUIRED = false
```
