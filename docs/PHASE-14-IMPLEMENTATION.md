# Phase 14 Implementation — Planning

**Slice:** 14A–14E complete · **DB verified:** 14A–14E yes (49/49 controlled acceptance)

> **Permanent rule:** ALL Teller Supabase migrations and SQL patches are manually applied by the operator.

---

## 14E scope (implemented)

Phase 14E adds assumption-driven forecast refinement on top of the 14D rolling forecast engine. No schema changes beyond the already-applied 14D patch.

| Area | Status |
|------|--------|
| Assumption application engine | `src/lib/planning/forecasts/assumption-engine.ts` |
| Assumption validation | `assumption-validation.ts` |
| Preview (read-only) | `POST …/versions/[versionId]/preview` |
| Refresh (bulk persist) | `POST …/versions/[versionId]/refresh` |
| Manual override save/clear | `POST …/versions/[versionId]/overrides` |
| Assumption builder UI | `ForecastAssumptionBuilder.tsx` |
| Editor workflow | Preview → Refresh; override indicators |
| Budget variance in summary | Phase 14C variance helpers |
| Stale forecast action | Create updated forecast when GL advances |
| Controlled DB acceptance | +4 scenarios (49 total) |

### Assumption types (V1)

| Type | Example |
|------|---------|
| `percentage_change` | Revenue +8% starting Sep 2027 |
| `fixed_monthly_amount` | Rent = $5,000 starting Jul 2027 |
| `target_margin` | Target gross margin 38% (all COGS scope) |
| `month_multiplier` | December revenue +20% |
| `note` | Documentation only |

### Target scopes

`all_revenue` · `all_cogs` · `all_expense` · `account` (validated P&L account in org)

### Precedence (deterministic)

1. **Actual GL** — actualized periods never receive growth assumptions
2. **Manual override** (`source_kind = manual`)
3. **Assumptions** — sorted by priority, then name; each applies to **baseline**, not prior calculated values
4. **Baseline** — budget/clone forecast lines, source budget version, or `metadata.baselineAmount` on assumption lines

### Baseline & idempotency

- Refresh always recalculates from stable baseline, not from prior assumption output.
- Budget-seeded forecasts load baseline from linked `source_budget_version_id` plus any `budget`/`clone` line overrides.
- Assumption lines persist `metadata.baselineAmount` so repeat refresh does not compound (Refresh #1 = +10%, Refresh #2 = same result).

### Preview vs refresh

- **Preview:** in-memory only; `ASSUMPTION_PREVIEW_MUTATES_DB = false`
- **Refresh:** bulk upsert assumption + baseline lines; preserves manual overrides and actualized periods

### Published immutability

Published/archived versions reject assumption CRUD, refresh, and manual override (DB triggers + domain guards).

### Audit events

`forecast_assumption_created` · `forecast_assumption_updated` · `forecast_assumption_deleted` · `forecast_refreshed` · `forecast_override_cleared`

### Deferred (14G+)

- Payroll, recurring, inventory/GRNI/PO, and capex cash adapters
- Scenarios / upside-downside cases
- Planning dashboard cards
- Forecast vs prior forecast comparison UI (engine hooks partial; full report deferred)

---

## 14F scope (implemented — requires manual SQL patch)

Manual patch (operator applies; do not auto-run):

`supabase/patches/033-phase14f-cash-forecast.sql`

| Area | Status |
|------|--------|
| Cash forecast runs + detail lines + manual overrides | Manual patch |
| 13-week horizon (Mon–Sun weeks) | `buildCashHorizonWeeks` |
| Starting cash | GL bank/cash asset balances as of as-of date |
| AR collections adapter | Open invoices, remaining balance, due-date timing |
| AP payments adapter | Open bills/expenses, remaining balance, due-date timing |
| Default timing | `teller_planning_settings` AR/AP days when no due date |
| Party overrides | `party_overrides` jsonb when present on settings row |
| Overdue AR/AP | Week 1 bucket + warnings |
| Manual adjustments | Planning-only `teller_cash_forecast_overrides` |
| Weekly roll-forward | Opening = prior closing; exact cents |
| Summary | Lowest cash, first negative week, simple runway |
| UI | `/app/planning/cash` |
| Unit tests | `src/lib/planning/reports/phase14f.test.ts` |
| Controlled DB acceptance | +11 scenarios (after patch) |

### 13-week horizon semantics

- **As-of date:** user-selected or today; drives horizon start.
- **Week boundaries:** Monday start, Sunday end (ISO-style, local calendar parsing).
- **Horizon:** 13 full weeks beginning with the Monday on or before the as-of date.
- **Overdue:** due dates before horizon start → Week 1.
- **Beyond horizon:** due dates after week 13 end → excluded from weekly totals (`beyondHorizon` list).

### Starting cash source

`STARTING_CASH_SOURCE = GL` — eligible asset accounts with subtype `bank` or `cash`, or code `1000`. Multiple accounts roll up to total starting cash with breakdown.

### Accounting boundary

`CASH_PLANNING_POSTS_TO_GL = false` — cash planning never posts journals or mutates AR/AP documents.

### Deferred (14I+)

- Planning dashboard cards
- Owner KPI home cards

---

## 14G scope (implemented)

Extends the 14F cash engine with read-only source adapters. No schema patch required (`MIGRATION_033_REQUIRED = false`).

| Adapter | Source | Precedence |
|---------|--------|------------|
| Payroll | Posted runs − settlements; future dates from cadence + last run | Posted > projected |
| Recurring | Active bill templates; skips posted/generated bills | Posted bill > scheduled occurrence |
| Purchasing | GRNI receipt lines; open PO unreceived qty | AP bill > GRNI > PO |
| Capex | Manual overrides with `planningCategory: capex` | Planned only (depreciation excluded) |

### Global dedupe

`dedupe.ts` collapses overlapping events by stable `dedupeKey` with source-kind precedence. Projected payroll is suppressed when a posted run exists for the same pay date. Recurring forecasts are suppressed when a bill already exists for the template occurrence.

### UI

`/app/planning/cash` — source coverage panel, category-grouped week detail, unscheduled purchasing list, capex category on manual adjustments.

### Tests

- Unit: `src/lib/planning/reports/phase14g.test.ts` (17 tests)
- Controlled DB: +8 scenarios (payroll, recurring, capex, PO, GRNI/PO split, coverage, tenant isolation, read-only)

---

## 14H scope (implemented — requires manual SQL patch)

Manual patch: `supabase/patches/034-phase14h-scenarios.sql`

| Area | Status |
|------|--------|
| Scenario tables | `teller_scenarios`, `teller_scenario_drivers`, `teller_scenario_cash_adjustments` |
| Scenario types | Base, Downside, Upside, Custom |
| Source lineage | Locked `forecast_id` + `forecast_version_id` per scenario |
| Forecast overlay | Revenue %, COGS % or gross margin points, expense % (forward periods only) |
| Cash overlay | AR/AP day shifts; payroll/purchasing/capex % on projected sources; scenario-only manual cash |
| Real obligation protection | AP bills, GRNI, posted payroll not amount-adjusted |
| Comparison | Side-by-side forecast + cash metrics vs Base |
| UI | `/app/planning/scenarios`, `/new`, `/[id]` |
| Audit | `scenario_created`, `scenario_updated`, `scenario_archived` |
| Controlled DB acceptance | +12 scenarios (after patch) |

### Overlay semantics

```
Source forecast / cash (unchanged)
  → apply scenario drivers in memory
  → scenario result (derived only)
```

- **Base:** empty driver set — mirrors source without duplication writes.
- **Preview:** read-only calculation; no DB writes except explicit save.
- **Idempotency:** drivers apply once per recalculation (no compounding).
- **Actual periods:** GL actual months in forecast are never rewritten by scenario drivers.

### Driver types (V1)

`revenue_percentage`, `cogs_percentage`, `expense_percentage`, `gross_margin_points`, `ar_days_adjustment`, `ap_days_adjustment`, `payroll_percentage`, `purchasing_percentage`, `capex_percentage`, `note`

`cogs_percentage` and `gross_margin_points` are mutually exclusive (validated server-side).

### Accounting boundary

`SCENARIOS_POST_TO_GL = false` — scenarios never post journals or mutate source forecast lines, cash forecast runs, AR/AP, payroll, or inventory.

### Deferred (14I+)

- Planning dashboard / owner cards
- Accountant planning package expansion
- Multi-entity scenario consolidation

---

## 14D scope (implemented — requires manual SQL patch)

Migration 032 includes forecast headers/versions only. Phase 14D adds application layer plus manual patch:

`supabase/patches/032-phase14d-forecast-lines.sql`

| Area | Status |
|------|--------|
| Forecast lines + assumptions tables | Manual patch |
| Forecast CRUD + lifecycle | draft / published / archived |
| Rolling 12-month engine | Forward months after anchor |
| Actual + forecast blend | GL YTD + stored future lines |
| Start from budget / blank | Budget seed maps horizon months |
| Assumptions | Name, kind, value metadata |
| Manual overrides | Draft bulk upsert |
| Published immutability | DB trigger + publish RPC |
| Revision | Clone RPC |
| Stale forecast flag | Published vs newer GL |
| UI | `/app/planning/forecasts` |
| Controlled DB acceptance | +8 scenarios (after patch) |

### Rolling horizon

- **Anchor month:** as-of month (first of month).
- **YTD actuals:** Jan through `actual_cutoff_month` from canonical GL.
- **Forward horizon:** next N months (default 12) from forecast lines.
- **Published:** stored lines only (reproducible snapshot).

### Deferred (14E+)

- 13-week cash planning, AR/AP timing, scenarios, planning dashboard cards

Note: assumption-driven refinement delivered in 14E; cash planning begins in 14F.

---

## 14C scope (implemented)

| Area | Status |
|------|--------|
| Budget vs Actual engine | GL actuals + budget version adapter |
| Monthly / YTD / annual columns | Month + YTD + annual plan progress |
| Variance $ and % | `actual - budget`; N/M when budget = 0 |
| Favorable / unfavorable | Type-aware (revenue vs expense/COGS) |
| Category rollups | Revenue, COGS, Gross Profit, Expenses, Operating Income |
| Unbudgeted actuals | Surfaced explicitly |
| Report UI | `/app/planning/budget-vs-actual` |
| CSV export | `?format=csv` on report API |
| Controlled DB acceptance | 36/36 PASS (14A+14B+14C) |

### Actual source

- **Actual:** Phase 10 `teller_gl_account_totals` via `periodActivityFromTotals` (canonical GL).
- **Budget:** Selected version lines from `teller_budget_lines` (defaults to latest approved/locked).
- **Read-only:** No journals, no budget mutations during reporting.

### Variance rules

| Formula | Value |
|---------|-------|
| Variance $ | `Actual − Budget` |
| Variance % | `Variance / \|Budget\|`; `0%` when both zero; `N/M` when budget zero and actual non-zero |
| Revenue favorable | Actual > Budget |
| Expense / COGS favorable | Actual < Budget |

Sign normalization uses positive owner-facing magnitudes for P&L types (`normalizeOwnerFacingAmount`).

### Route

- UI: `/app/planning/budget-vs-actual`
- API: `GET /api/planning/reports/budget-vs-actual?fiscalYear=&throughMonth=&versionId=`
- Export: append `&format=csv`

### Deferred (14D+)

- Forecasting, rolling forecast, cash planning, scenarios, dashboard cards, accountant package section

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
npm run test:fast                              # includes phase14 + phase14b + phase14c/d/e tests
TELLER_TEST_PHASE=14 npm run test:phase        # unit + migration object verify
npm run verify:migration:032:controlled        # applied DB object gate
npm run accept:phase14:controlled              # 49-scenario DB acceptance (14A–14E, after patch)
```

---

## Phase 14C controlled DB verification (2026-09-08)

| Gate | Result |
|------|--------|
| Budget vs actual engine (GL + budget lines) | PASS |
| YTD aggregation | PASS |
| Unbudgeted actual visibility | PASS |
| Tenant isolation (foreign version) | PASS |
| Planning journals created | 0 |

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
PHASE_14C_CODE_COMPLETE = true
PHASE_14C_DB_VERIFIED = true
PHASE_14C_COMPLETE = true
PHASE_14D_CODE_COMPLETE = true
PHASE_14D_DB_VERIFIED = true
PHASE_14D_COMPLETE = true
PHASE_14E_CODE_COMPLETE = true
PHASE_14E_DB_VERIFIED = true
PHASE_14E_COMPLETE = true
PHASE_14E_STARTED = true
PHASE_14F_CODE_COMPLETE = true
PHASE_14F_DB_VERIFIED = true
PHASE_14F_COMPLETE = true
PHASE_14F_STARTED = true
PHASE_14G_CODE_COMPLETE = true
PHASE_14G_DB_VERIFIED = true
PHASE_14G_COMPLETE = true
PHASE_14G_STARTED = true
PHASE_14H_CODE_COMPLETE = true
PHASE_14H_DB_VERIFIED = true
PHASE_14H_COMPLETE = true
PHASE_14H_STARTED = true
PHASE_14I_CODE_COMPLETE = true
PHASE_14I_DB_VERIFIED = true
PHASE_14I_COMPLETE = true
PHASE_14I_STARTED = true
PHASE_14J_STARTED = true
PHASE_14J_CODE_COMPLETE = true
PHASE_14J_DB_VERIFIED = true
PHASE_14J_COMPLETE = true
PHASE_14K_STARTED = true
PHASE_14K_COMPLETE = true
PHASE_14L_STARTED = true
PHASE_14L_COMPLETE = true
PHASE_14_COMPLETE = true
PRODUCTION_DEPLOYED_FOR_PHASE14 = true
```

---

## 14L scope (production deploy + post-deploy verification)

**Completed:** 2026-09-09  
**Release commit:** `ca0ac38dacb8c45ed31c6a290d4276fb13b7f3d9`  
**Production URL:** `https://teller-indol.vercel.app`  
**Deployment ID:** `dpl_7RH5vHiGNFVv6tU1nhZ79oJEcn44`  
**Deployment state:** Ready (Vercel GitHub status success on release SHA)

| Gate | Result |
|------|--------|
| Release commit created | PASS — `ca0ac38` (108 files, Phase 14A–K) |
| Secrets in release commit | 0 |
| `LOCAL_HEAD = ORIGIN_MAIN` | PASS |
| Pre-deploy `test:fast` | **207/207 PASS** |
| Pre-deploy Phase 14 tests | PASS |
| Static schema verify | `npm run verify:phase14:planning` PASS |
| Pre-deploy production read | `verify:migration:032:controlled` PASS; HFAC counts match pre snapshot |
| Production deploy | Auto-deploy from `main` push; alias updated |
| Production alias | `https://teller-indol.vercel.app` → `dpl_7RH5vHiGNFVv6tU1nhZ79oJEcn44` |
| Deployed SHA = release SHA | PASS (GitHub Vercel check on `ca0ac38`) |
| Planning routes smoke | PASS — `/login` 200; planning/reports routes 307 (auth); APIs 401 |
| Owner dashboard (14I) | PASS — release includes `PlanningDashboardView` + `/api/planning/dashboard` |
| Accountant package (14J) | PASS — Planning tab, close context, `/api/planning/accountant-package` wired |
| Post-deploy Phase 14 schema | PASS — all planning tables present (read-only probe) |
| Post-deploy journals balanced | PASS |
| HFAC baseline unchanged | PASS (8 docs, 3 payments, 16 journals, 0 HFAC planning) |
| Phase 14 orphans | 0 (budget/forecast lines without version) |
| Deploy accounting writes | 0 journals / 0 documents / 0 payments created |
| Runtime logs (bounded) | 0 blocking errors |
| Migrations/SQL auto-applied | false (manual rule upheld) |

**Snapshots**

- Pre-deploy: `artifacts/controlled-prod-snapshots/pre-phase14-deploy-2026-09-09T16-25-36-386Z.json`
- Post-deploy: `artifacts/controlled-prod-snapshots/post-phase14-deploy-2026-09-09T19-34-36-183Z.json`
- Pre/post HFAC accounting differences: **0**
- Pre/post global planning fixture counts unchanged (controlled demo org data only)

**Phase 15:** NEXT / NOT STARTED

---

## 14K scope (final acceptance — verification only)

Final Phase 14 regression gate across slices 14A–14J. No new product features.

| Gate | Result |
|------|--------|
| Static schema verify | `npm run verify:phase14:planning` PASS |
| Production schema probe | `npm run verify:migration:032:controlled` PASS |
| Controlled DB acceptance | **106/106 PASS** (includes cross-module + cash reconciliation) |
| Fast tests | **207/207 PASS** |
| Phase 14 tests | PASS |
| Affected tests | PASS |
| Full release gate | `npm run test:full` PASS (after build fixes) |
| Production build | PASS (after TS fixes) |
| Pre-deploy snapshot | `artifacts/controlled-prod-snapshots/pre-phase14-deploy-*.json` |

### 14K cross-module assertions (controlled acceptance)

- Dashboard vs accountant package financial parity (shared as-of date)
- Source lineage consistency (budget / forecast / cash)
- Cash weekly reconciliation (opening + flows = closing; week roll-forward)
- Missing-data graceful degradation (empty org FY2099)
- Partial-data independence (budget / forecast / cash cards load separately)

### Accounting safety (verified)

- `PHASE14_POST_JOURNAL_CALLS = 0` in planning code
- `PLANNING_JOURNALS_CREATED = 0` on all planning reads
- `HFAC_BASELINE_UNCHANGED = true` (documents=8, journals=16, planning on HFAC=0)
- `UNBALANCED_PRODUCTION_JOURNALS = 0` (snapshot)
- `PHASE14_ORPHANS = 0`

### Defects found and fixed during 14K (minimal)

1. **Build TS:** `ctx.userId` → `ctx.session.userId` in cash API routes
2. **Build TS:** Scenario driver typing in scenario API routes
3. **Build TS:** Supabase join row typing in `purchasing-adapter`, `seed-from-budget`
4. **Build TS:** Tuple typing in `BudgetVsActualReportView`, `ForecastEditor`
5. **Acceptance harness:** Cross-module compare aligned to shared `REPORT_PERIOD_END` as-of

### Known deferrals (unchanged)

- Phase 15+ (sales tax, multi-entity, ML forecasting, treasury, etc.)
- Pre-existing ESLint `react-hooks/set-state-in-effect` in scenario UI (14H lint, non-blocking)

---

## 14J scope (implemented — no schema patch)

Accountant planning package + period-close integration — aggregation/reporting only.

| Area | Status |
|------|--------|
| Orchestrator | `loadAccountantPlanningPackage()` in `src/lib/planning/accountant-package/` |
| API | `GET /api/planning/accountant-package` (`format=csv` for export) |
| Reports UI | **Planning** tab on `/app/reports` |
| Close UI | Read-only planning context on `/app/accounting/close/[period]` |
| Combined export | `includePlanning=1` on `/api/reports/accountant-package` |
| Accounting boundary | Read-only — 0 journals; planning does not block close |

### Package sections

1. Budget vs Actual — current period + YTD variance (favorable/unfavorable)
2. Current Forecast — expected revenue / gross profit / operating income; stale indicator
3. 13-Week Cash Forecast — summary + category totals + source coverage
4. Scenario Analysis — Base / Downside / Upside when configured
5. Planning Risks — max 5 deterministic items
6. Source Lineage — budget, forecast, cash, scenarios, report period

### Close independence

- `PLANNING_BLOCKS_PERIOD_CLOSE = false`
- `CLOSE_REWRITES_PLANNING = false`
- Close page shows informational context only

### Source mismatch warnings

Deterministic checks when scenario forecast version ≠ package forecast, or forecast budget link ≠ package budget.

### Material variance

YTD variances ≥ $25,000 surfaced in risk summary and material variance list (top 3).

### Tests

- Unit: `src/lib/planning/reports/phase14j.test.ts`
- Controlled acceptance: +10 scenarios in `scripts/controlled-phase14-db-acceptance.ts`

---

## 14I scope (implemented — no schema patch)

Owner planning dashboard at `/app/planning` — aggregation only, no new financial engines.

| Area | Status |
|------|--------|
| Orchestrator | `loadPlanningDashboard()` in `src/lib/planning/dashboard/` |
| API | `GET /api/planning/dashboard` |
| UI | Six primary cards + Needs Attention + Quick Actions + optional 13-week cash chart |
| Source selection | Approved/locked budget; published forecast (draft fallback); active downside scenario |
| Attention | Max 5 items, deterministic severity (critical / warn / info) |
| Accounting boundary | Read-only — 0 journals |

### Primary cards (max 6)

1. Vs Plan — Budget vs Actual YTD operating income
2. Expected Revenue — rolling forecast vs plan
3. Expected Operating Income — rolling forecast vs plan
4. 13-Week Cash Outlook — ending / starting cash
5. Lowest Projected Cash — lowest week + first negative week
6. Downside Outlook — scenario ending cash vs base (CTA if missing)

