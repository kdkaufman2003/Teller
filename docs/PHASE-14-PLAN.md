# Phase 14 — Budgeting, Forecasting & Cash Planning

**Status:** Planning complete · **Build-ready:** yes · **Implementation:** not started  
**Prerequisite:** Phase 13 complete (`PHASE_13_COMPLETE = true`)

> **Permanent rule:** ALL Teller Supabase migrations and SQL patches are manually applied by the operator. Migration 032 is designed here but must not be auto-applied.

---

## Executive summary

Phase 14 adds **planning truth** on top of Teller’s existing **accounting truth**. Small-business owners get answers to: *How are we doing against plan? What do the next few months look like? How much cash will we have? When might it get tight? What if sales drop or costs rise?*

This is **not** enterprise FP&A. No ML, no auto-posting, no treasury management. Planning data never creates journals or mutates GL/subledger balances.

---

## 1. Product boundary

### In scope (V1)

| Area | V1 deliverables |
|------|-----------------|
| **Budgeting** | Annual + monthly org budget; account-level lines; fiscal-year scoped; versions (draft → approved → locked); clone/copy-forward; prior-year actual baseline import; CSV import/export |
| **Forecasting** | Rolling 12-month financial forecast; actuals + forecast blend; manual + rule-based assumptions; forecast versions (immutable when published); account-level P&L focus |
| **Cash planning** | Projected cash balance; AR/AP timing; payroll cash; recurring schedules; inventory/AP precedence; planned capex (manual); 13-week cash outlook |
| **Scenarios** | Base / Downside / Upside + custom; assumption overlays; comparison without altering accounting |
| **Reporting** | Budget vs actual; forecast vs actual; forecast vs budget; rolling forecast P&L; cash forecast; cash runway; scenario comparison; variance detail |
| **Dashboard** | Limited owner cards (cash outlook, runway, budget variance headline) |
| **Integration** | Phase 5 cash, 6 AP, 7 job budgets, 8 FA depreciation/capex plans, 9 close (informational), 10 reports, 11 schedules, 11.1 accruals, 12 payroll, 13 inventory/GRNI |

### Explicit exclusions

| Excluded | Rationale |
|----------|-----------|
| Treasury / investment / borrowing decisions | Not a bank; out of V1 scope per product rules |
| Loan origination / covenant tracking | No lending product |
| ML / statistical forecasting | Explainability requirement; deferred |
| Auto-posting forecast/budget to GL | Planning ≠ accounting truth |
| Scenario-generated journal entries | Scenarios are analytical only |
| Tax planning engine | Deferred; may show liability balances as cash outflows only |
| Department / class / location GL dimensions | **Not in Teller schema** — defer until dimensions exist |
| Daily financial forecast grain | Monthly sufficient for V1 |
| Multi-entity consolidation | Phase 16+ |
| Complex workforce planning | Payroll forecast from Phase 12 cadence only |
| HFAC integration | Hard refusal boundary preserved |
| Production scheduler for forecast refresh | Manual + on-demand refresh V1 |

---

## 2. Accounting truth vs planning truth

```
┌─────────────────────────────────────────────────────────────┐
│  ACTUAL (accounting truth)                                   │
│  GL journals, subledgers, AR/AP balances, bank recon,       │
│  inventory valuation, payroll recognition/settlement         │
│  — immutable posted history, period locks apply                │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ read-only inputs
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  BUDGET (planning truth)                                     │
│  Approved target by account × month                            │
│  — never posts; locked versions immutable                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  FORECAST (planning truth)                                   │
│  Actual history + projected future by account × month        │
│  — published versions are frozen snapshots                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  SCENARIO (planning overlay)                                 │
│  Parameter overrides on a forecast version                   │
│  — isolated; never writes back to budget/forecast/actual     │
└─────────────────────────────────────────────────────────────┘
```

**Hard rules (non-negotiable):**

- Planning modules **must not** call `teller_post_journal` or any atomic GL RPC
- Planning **must not** UPDATE posted journals, documents, payments, inventory movements, payroll runs
- Planning **must not** bypass RLS or use client-supplied `organization_id` without session auth
- Closed periods: actuals for planning come from canonical GL totals; reopening a period triggers **forecast refresh recommendation**, not silent mutation of published snapshots
- Bank reconciliation state is unaffected by planning

**Lineage fields on every planning row:**

- `source_kind`: `manual` | `import` | `assumption` | `actual_baseline` | `clone` | `scenario_overlay`
- `source_id`: optional UUID/text reference
- `source_version_id`: budget/forecast version that produced the line

---

## 3. Budget architecture

### Entity model

```
teller_budgets (1 per org × fiscal year × budget_type)
  └── teller_budget_versions (draft | submitted | approved | locked | archived)
        └── teller_budget_lines (account × period × optional job)
```

**`teller_budgets`**

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| organization_id | uuid FK | tenant |
| name | text | e.g. "2026 Operating Budget" |
| fiscal_year | int | aligns with org fiscal year config |
| budget_type | text | `operating` (V1 only) |
| currency_code | text | default org currency |
| status | text | `active` \| `archived` (header lifecycle) |
| metadata | jsonb | |
| created_at / updated_at | timestamptz | |

Unique: `(organization_id, fiscal_year, budget_type)` where status = active

**`teller_budget_versions`**

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| organization_id | uuid FK | |
| budget_id | uuid FK | |
| version_number | int | monotonic per budget |
| label | text | e.g. "Board approved v2" |
| status | text | `draft` \| `submitted` \| `approved` \| `locked` \| `archived` |
| baseline_kind | text | `blank` \| `prior_year_actual` \| `prior_version` |
| baseline_version_id | uuid | nullable FK |
| approved_at | timestamptz | |
| approved_by | uuid | auth user |
| locked_at | timestamptz | |
| notes | text | |
| metadata | jsonb | |

Unique: `(budget_id, version_number)`

**Immutability policy:**

- `draft`: editable
- `submitted`: editable by approvers only (V1: owner/admin)
- `approved` / `locked`: **lines immutable** — changes require new version (clone → increment)
- `archived`: read-only historical

**`teller_budget_lines`**

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| organization_id | uuid FK | |
| budget_version_id | uuid FK | |
| account_id | uuid FK → teller_accounts | required |
| period_month | date | first day of month |
| amount | numeric(14,2) | signed per account normal balance convention |
| job_id | uuid FK | **optional** — V1 for job-scoped budget lines only |
| source_kind / source_id | text/uuid | lineage |
| notes | text | |
| metadata | jsonb | |

Unique: `(budget_version_id, account_id, period_month, job_id)` with null-safe job

**Job budget relationship:** Keep existing `teller_job_budget_lines` (Phase 7). Org budget job_id lines are optional roll-ups; job profitability continues to use job budget for **job** budget vs actual. Phase 14 adds org-level P&L budget alongside, not replacement.

---

## 4. Budget line granularity (V1 vs deferred)

| Dimension | V1 | Notes |
|-----------|-----|-------|
| organization | ✅ | implicit |
| account (COA) | ✅ | required |
| period (month) | ✅ | required |
| job_id | ✅ optional | only where job planning already exists |
| party (customer/vendor) | ❌ deferred | no party-level budget V1 |
| department/class | ❌ deferred | dimensions don't exist in GL |
| inventory location | ❌ deferred | stock subledger only |

---

## 5. Forecast architecture

### Entity model

```
teller_forecasts (rolling plan container)
  └── teller_forecast_versions (draft | published | archived)
        ├── teller_forecast_lines (account × month × amount)
        └── teller_forecast_assumptions (rules + parameters)
```

**Rolling forecast definition:**

- Horizon: **12 months forward** from forecast anchor month (default: current open month)
- Historical actual months: pulled from `teller_gl_account_totals` through last closed month or selected cutoff
- Future months: forecast lines + assumption engine output
- As periods close, next forecast generation shifts window (Jan–Aug actual + Sep–Dec forecast → Feb–Sep actual + Oct–Jan forecast)

**`teller_forecasts`**

| Column | Notes |
|--------|-------|
| organization_id | tenant |
| name | e.g. "Main rolling forecast" |
| forecast_kind | `rolling_pl` (V1) |
| anchor_month | date | first of month |
| horizon_months | int | default 12 |
| active | boolean | one active per kind per org |

**`teller_forecast_versions`**

| Column | Notes |
|--------|-------|
| status | `draft` \| `published` \| `archived` |
| published_at | timestamptz |
| actual_cutoff_month | date | last month treated as actual input |
| snapshot_hash | text | optional integrity check |
| is_immutable | boolean | true when published |

**Published forecast = frozen snapshot.** Recalculation creates a **new version**; prior published versions remain for historical comparison ("what we thought last month").

**Forecast line source types (`source_kind`):**

| source_kind | Description |
|-------------|-------------|
| `actual` | From GL totals (historical) |
| `manual` | User entered |
| `budget` | Copied from approved budget version |
| `growth_pct` | Assumption-driven |
| `fixed_monthly` | Assumption-driven |
| `seasonal_pct` | Assumption-driven |
| `recurring_schedule` | Phase 11 projection |
| `ar_projection` | Open invoice collection |
| `ap_projection` | Open bill payment |
| `payroll_projection` | Phase 12 cadence |
| `capex_plan` | Manual planned asset purchase |
| `depreciation_analytical` | Phase 8 schedule (non-posting) |
| `inventory_purchase` | Phase 13 precedence chain |

---

## 6. Forecast assumption engine (V1)

Assumptions are **declarative and explainable**. Each produces auditable explanation text.

**`teller_forecast_assumptions`**

| Column | Notes |
|--------|-------|
| forecast_version_id | FK |
| assumption_kind | enum (below) |
| target_scope | `organization` \| `account` \| `account_group` \| `report_line` |
| target_account_id | nullable |
| target_report_line_key | nullable |
| parameters | jsonb | kind-specific |
| effective_start_month | date |
| effective_end_month | date |
| priority | int | lower = applied first |
| explanation_template | text | filled at calc time |

**V1 assumption kinds:**

| Kind | Parameters | Example explanation |
|------|------------|-------------------|
| `prior_year_growth_pct` | `{ pct: 5 }` | "Revenue +5% vs prior year same month" |
| `trailing_avg_growth_pct` | `{ months: 3, pct: 2 }` | "+2% vs 3-month trailing average" |
| `fixed_monthly_amount` | `{ amount: 5000 }` | "Fixed $5,000/month" |
| `seasonal_pct_by_month` | `{ "1": 0.8, "12": 1.2 }` | "December seasonality 120%" |
| `copy_budget_version` | `{ budget_version_id }` | "From approved budget v3" |
| `manual_override` | `{ amount }` | "Manual override" |
| `ar_collection_days` | `{ days: 30 }` | org default or override |
| `ap_payment_days` | `{ days: 15 }` | org default or override |
| `payroll_next_dates` | `{ cadence: biweekly }` | from org payroll pattern |
| `one_time_expense` | `{ month, amount, label }` | "Planned equipment repair" |
| `planned_capex` | `{ month, amount, label }` | cash outflow only until asset acquired |

**No black box.** UI shows assumption chain per line.

---

## 7. Cash forecast architecture

Cash planning is a **separate projection layer** that rolls up into weekly + monthly buckets.

```
Starting cash (actual bank GL balances as of as-of date)
+ Sum(projected inflows by period)
- Sum(projected outflows by period)
= Projected ending cash
```

**`teller_cash_forecast_runs`** (materialized run per forecast version + scenario)

| Column | Notes |
|--------|-------|
| organization_id | |
| forecast_version_id | FK |
| scenario_id | nullable FK |
| as_of_date | date |
| starting_cash | numeric |
| horizon_weeks | int | default 13 for cash view |
| status | `draft` \| `published` |
| published_at | timestamptz |

**`teller_cash_forecast_lines`**

| Column | Notes |
|--------|-------|
| cash_forecast_run_id | FK |
| period_start | date | week start or month start |
| period_grain | `week` \| `month` |
| flow_kind | `inflow` \| `outflow` |
| category | text | `ar_collection` \| `ap_payment` \| `payroll` \| `recurring` \| `capex` \| `tax` \| `deposit` \| `manual` \| … |
| amount | numeric(14,2) |
| source_kind | text | lineage |
| source_id | uuid | document, schedule, override, etc. |
| explanation | text | required for calculated rows |
| is_override | boolean | |
| metadata | jsonb | |

**`teller_cash_forecast_overrides`**

Manual adjustments with label, amount, period, flow_kind — linked to run.

**Starting cash resolution:**

1. Sum GL balances for accounts where `subtype = 'bank'` (via `teller_bank_accounts.gl_account_id` linkage)
2. Fallback: accounts with code pattern / subtype bank from COA
3. As-of date = today or user-selected (uses same totals RPC as balance sheet cash lines)

---

## 8. AR cash projection

**Inputs:** Open posted invoices (`teller_documents` kind invoice, status billed/open, balance > 0)

**Collection date priority:**

1. Manual override on invoice (V1: per-run override table keyed by document_id)
2. Customer-specific `collection_days` if configured in `teller_planning_settings.party_overrides` jsonb
3. Invoice `due_date`
4. `issue_date + org_default_ar_collection_days`

**Overdue handling:**

- If computed collection date < as_of_date → use `as_of_date + grace_days` (default 0) or manual override
- Never leave cash in a past bucket silently — roll forward with warning flag `overdue_invoice_rolled`

**Do not double-count:**

- Invoices already fully paid → exclude
- Credit memos reduce AR before collection projection
- Customer deposits are **not** revenue collection — separate category

---

## 9. AP cash projection

**Inputs:** Open posted bills with AP balance

**Payment date priority:**

1. Manual override
2. Vendor-specific payment days (party override)
3. Bill `due_date`
4. `issue_date + org_default_ap_payment_days`

**Double-count prevention hierarchy (critical):**

| Economic state | Cash outflow source | Exclude |
|----------------|---------------------|---------|
| Bill posted, open balance | AP projection | PO, GRNI, accrual for same economics |
| GRNI receipt, no bill | GRNI expected bill date + payment days | PO commitment |
| PO only, no receipt | PO expected receipt + bill + payment chain | — |
| Accrual schedule, no bill | Schedule occurrence date (Phase 11) | If bill exists via 11.1 settlement |
| Recurring bill template | Next scheduled generation date | If bill already exists for period |
| Posted bill payment | **Actual** payment date (already in bank) | Remove from future AP projection |

**GRNI / inventory precedence (Phase 13):**

```
1. If bill exists with allocation → use AP
2. Else if receipt exists (GRNI open) → project bill + payment
3. Else if PO open commitment → project receipt → bill → payment (uses expected dates)
4. Never sum PO + GRNI + bill for same line item
```

Implementation: adapter reads `teller_inventory_receipt_bill_allocations`, receipt line status, PO line quantities — assigns **one** cash candidate per economic unit.

---

## 10. Payroll forecast integration (Phase 12)

**Two streams:**

| Stream | Source | Cash timing |
|--------|--------|-------------|
| Future payroll | `teller_planning_settings.payroll_cadence` + last run date | projected pay dates |
| Posted unpaid liabilities | `teller_payroll_liability_settlements` pending + open liability GL | settlement date or due |

**Rules:**

- After payroll run **posted** → use actual liability amounts, not forecast template
- After settlement **posted** → remove from cash outflow projection
- Net pay, tax, benefit components as separate cash lines (mirror Phase 12 settlement types)
- Do not rebuild payroll calculation engine — use historical run amounts × cadence for future forecast unless manual override

---

## 11. Inventory / purchasing forecast

See AP precedence §9. Additional analytical (P&L forecast, not cash):

- Planned inventory purchases (manual assumption)
- Expected COGS from material issue trends (optional V1.1 — defer complex)

Cash only through AP/GRNI/PO chain.

---

## 12. Fixed asset / capex

| Type | Treatment |
|------|-----------|
| Existing assets | Analytical depreciation from Phase 8 schedule (already posted going forward = use actual scheduled amounts from register) |
| Planned capex | Manual `planned_capex` assumption → **cash outflow only** |
| Asset acquisition | Does not create fixed asset until Phase 8 posting event occurs |

---

## 13. Recurring schedule integration (Phase 11)

**Source:** `teller_accounting_schedules` + `teller_schedule_occurrences` where status = `scheduled`

**Rules:**

- Include future occurrences not yet posted
- Exclude occurrence if linked bill/journal already exists for that period
- Accrual schedules: cash projection uses expected **payment** date, not recognition date (configurable per schedule type in V1 with sensible defaults)
- Deferred revenue releases: inflow timing if cash-relevant (usually N/A — non-cash revenue recognition)

---

## 14. Cash runway model

Computed from published cash forecast run:

| Metric | Definition |
|--------|------------|
| `lowest_projected_cash` | min(ending cash per period) |
| `lowest_cash_date` | period where minimum occurs |
| `first_negative_cash_date` | first period ending cash < 0 (if any) |
| `runway_weeks` | weeks until cash < threshold (default threshold = 0) |
| `runway_months` | approximate months based on weekly/monthly buckets |

**Disclaimer (always show when assumptions incomplete):**  
*"Based on current forecast assumptions. Incomplete vendor terms or missing payroll dates may affect accuracy."*

**Warnings:**

- `missing_ap_terms`
- `overdue_ar_rolled`
- `no_payroll_cadence_configured`
- `unmatched_grni_items`

---

## 15. Time granularity

| Artifact | Grain |
|----------|-------|
| Budget | Monthly |
| Financial forecast (P&L) | Monthly |
| Cash forecast (detail) | **Weekly** (13-week view) |
| Cash forecast (summary) | Monthly roll-up |
| Dashboard cash card | 13-week headline |

Daily grain: **deferred**.

---

## 16. Scenario architecture

**`teller_scenarios`**

| Column | Notes |
|--------|-------|
| organization_id | |
| forecast_version_id | base published forecast |
| name | Base / Downside / Upside / custom |
| is_system | boolean for three defaults |
| status | `active` \| `archived` |

**`teller_scenario_assumptions`**

Parameter overlays — never mutate base forecast lines:

| Parameter | Example |
|-----------|---------|
| `revenue_growth_pct_delta` | -10% downside |
| `expense_growth_pct_delta` | +5% downside |
| `ar_collection_days_delta` | +15 days |
| `ap_payment_days_delta` | -7 days |
| `payroll_amount_pct_delta` | +3% |
| `capex_delta` | +$50k |
| `one_time_cost` | { month, amount } |

Scenario engine applies overlays → produces **derived lines in memory or scenario snapshot table** (`teller_scenario_results` materialized on demand).

**Comparison outputs:** Revenue, Gross Profit, Operating Income, Ending Cash, Lowest Cash, Runway

---

## 17. Variance engine

**For each report line / account:**

```
actual     = GL totals for period
budget     = locked budget version line
forecast   = published forecast version line
variance_budget = actual - budget
variance_forecast = actual - forecast
variance_pct = actual ? variance / abs(baseline) : null
```

**Favorable / unfavorable by account type:**

| Account type | Favorable when |
|--------------|----------------|
| revenue | actual > budget |
| expense | actual < budget |
| asset (cash) | actual > budget (informational) |
| liability | actual < budget (lower obligation) |

Use `teller_accounts.account_type` — do not apply naive sign logic.

**Zero denominator:** show `—` not infinity.

---

## 18. Reporting integration

**Architecture:** Extend Phase 10 report engine — do **not** fork actual GL source.

```
report-engine.ts
  ├── loadActuals()        ← existing teller_gl_account_totals (canonical)
  ├── loadBudgetVersion()  ← new planning loader
  ├── loadForecastVersion()← new planning loader
  └── buildPlanningReports() ← new composer
```

**New reports (routes under `/app/reports/planning/*` and `/app/planning/*`):**

| Report | Route suggestion |
|--------|------------------|
| Budget vs Actual P&L | `/app/reports/budget-vs-actual` |
| Forecast P&L | `/app/reports/forecast-pl` |
| Forecast vs Budget | `/app/reports/forecast-vs-budget` |
| Rolling Forecast | `/app/reports/rolling-forecast` |
| Cash Forecast | `/app/reports/cash-forecast` |
| Cash Runway | `/app/reports/cash-runway` |
| Scenario Comparison | `/app/reports/scenario-comparison` |
| Variance Detail | `/app/reports/variance-detail` |

**Drill-down:** account → monthly lines → source (assumption, document link read-only, manual override)

**Accountant package:** add CSV sections for budget vs actual, cash forecast summary (Phase 14F).

---

## 19. Dashboard integration

**Owner mode cards (max 6 on dashboard V1):**

| Card | Label (owner) |
|------|---------------|
| Cash outlook (13 weeks) | "Cash outlook" |
| Cash low point | "Lowest expected cash" |
| Cash runway | "Runway" |
| Budget variance (MTD revenue/expense) | "Vs plan this month" |
| Expected money in (30 days) | "Expected money in" |
| Expected bills & payroll (30 days) | "Expected bills and payroll" |

Accountant dashboard: same data, formal labels.

---

## 20. Owner vs accountant mode

Extend `presentation-mode.ts` with `OWNER_MODE_PLANNING_LABELS`:

| Accountant | Owner |
|------------|-------|
| Projected receivable realization | Expected money in |
| Projected liability settlements | Expected bills and payroll |
| Treasury forecast | Cash outlook |
| Budget variance | Vs plan |
| Rolling forecast | What the next months look like |

---

## 21. Data model summary (migration 032)

### New tables

| Table | Purpose |
|-------|---------|
| `teller_planning_settings` | Org defaults (AR/AP days, payroll cadence, thresholds) |
| `teller_budgets` | Budget header |
| `teller_budget_versions` | Version lifecycle |
| `teller_budget_lines` | Account × month amounts |
| `teller_forecasts` | Forecast container |
| `teller_forecast_versions` | Version + immutability |
| `teller_forecast_lines` | Account × month amounts |
| `teller_forecast_assumptions` | Assumption rules |
| `teller_scenarios` | Scenario definitions |
| `teller_scenario_assumptions` | Overlays |
| `teller_scenario_results` | Materialized scenario outputs (optional cache) |
| `teller_cash_forecast_runs` | Cash run header |
| `teller_cash_forecast_lines` | Weekly/monthly flows |
| `teller_cash_forecast_overrides` | Manual adjustments |
| `teller_planning_audit_events` | Planning audit trail |

### Indexes (representative)

- `(organization_id, fiscal_year)` on budgets
- `(budget_version_id, period_month, account_id)` on budget lines
- `(forecast_version_id, period_month, account_id)` on forecast lines
- `(organization_id, published_at desc)` on forecast versions
- `(cash_forecast_run_id, period_start, flow_kind)` on cash lines
- GIN on `planning_settings.party_overrides` if jsonb queries needed

### RLS

All tables: `teller_is_org_member` read, `teller_can_write_books` write — match Phase 11/13 pattern.

**No journal immutability triggers** on planning tables (editable drafts allowed).

### RPCs (minimal set)

| RPC | Purpose |
|-----|---------|
| `teller_atomic_publish_forecast_version` | Publish + snapshot immutability in one transaction |
| `teller_atomic_approve_budget_version` | Approve + lock lines |
| `teller_atomic_clone_budget_version` | Clone version + lines |
| `teller_atomic_clone_forecast_version` | Clone version + lines + assumptions |

Bulk line upserts can remain application-layer with batched inserts + org guard. No GL atomicity needed.

**Do not alter `teller_post_journal`.**

---

## 22. Materialization vs calculation

| State | Behavior |
|-------|----------|
| Draft budget/forecast | Live calculation + editable lines |
| Published forecast | **Persist all lines** — immutable |
| Approved budget | **Persist all lines** — immutable |
| Actuals in forecast | Always re-read from GL for draft; **frozen in published snapshot** |
| Cash forecast | Published run stores all lines |
| Scenarios | Compute on demand; optional cache in `teller_scenario_results` |

---

## 23. Audit plan

**`teller_planning_audit_events`**

| event_kind | Examples |
|------------|----------|
| `budget_created` | |
| `budget_version_submitted` | |
| `budget_version_approved` | |
| `budget_version_locked` | |
| `budget_cloned` | |
| `forecast_published` | |
| `assumption_changed` | |
| `cash_override_added` | |
| `scenario_created` | |
| `import_completed` | |

Fields: `organization_id`, `actor_id`, `entity_kind`, `entity_id`, `payload jsonb`, `created_at`

Do not reuse journal audit tables.

---

## 24. Period close interaction

- Closing books **does not block** planning edits
- Close readiness may add **informational** finding: "Published forecast predates latest close — consider refreshing"
- Reopening a closed period: flag affected published forecasts as `stale_actuals` — do not auto-mutate
- Budget vs actual for closed months uses final closed GL totals

---

## 25. Performance plan

- Use `teller_gl_account_totals` RPC for actuals — never scan raw journal lines in UI
- Budget/forecast line queries paginated by version + period range
- Published snapshots served from planning tables, not recalculated per page view
- Cash adapter queries batched by source type with limits
- Target: budget vs actual P&L < 2s for 100 accounts × 12 months on demo org
- Index all FK + `(organization_id, …)` access paths

---

## 26. Import / export (V1)

**CSV budget import columns:** `account_code`, `period_yyyy_mm`, `amount`, optional `job_number`, `notes`

**Rules:**

- Account must exist in org COA — **no silent account creation**
- Invalid rows reported with line numbers
- Import creates new draft version or updates current draft only

**Export:** same shape + metadata headers (version, fiscal year)

Excel: deferred.

---

## 27. Acceptance test plan

**Target: 75–90 real scenarios** (no placeholders)

| Category | Count | Examples |
|----------|-------|----------|
| Budget CRUD/version/approve/lock/clone | 12 | draft edit, approved immutability, clone increments version |
| Budget import/export | 6 | valid CSV, reject unknown account, reject duplicate lines |
| Forecast rolling blend | 10 | actual+forecast boundary, month roll-forward |
| Assumptions | 10 | growth %, seasonal, explain text present |
| Forecast immutability | 6 | publish freezes, new version on refresh |
| Cash AR | 8 | due date, overdue roll, customer override, no double count w/ payments |
| Cash AP | 10 | bill due, GRNI precedence, PO precedence, accrual vs bill |
| Payroll cash | 6 | posted run vs forecast, settlement removes |
| Recurring | 5 | scheduled occurrence, skip if posted |
| Capex | 4 | cash only, no FA creation |
| Scenarios | 8 | base/downside/upside, isolated overlay |
| Variance | 6 | revenue favorable, expense unfavorable, zero denom |
| Close/reopen | 4 | stale forecast flag, closed actual unchanged |
| Tenant/security | 6 | cross-org denial, invalid FK |
| Performance | 4 | large line set query bounds |
| HFAC | 2 | hard refusal, baseline unchanged |
| Dashboard/report smoke | 4 | owner labels, accountant labels |

**Harness:** `scripts/controlled-phase14-demo-runner.ts`, `accept:phase14:controlled` (DB scenarios ~40–50 subset for economic adapters, rest logic-only)

---

## 28. Test dependency map (Phase 14)

Add to `scripts/test-tier-config.mjs` when implementing:

**Module:** `planning`

**Primary modules for Phase 14:** `planning`, `financial_reporting`, `period_lock_close`, `banking`, `ap_purchasing`, `payroll`, `subledger_automation`, `inventory_grni`, `fixed_assets`, `job_costing`

**`test:fast` additions:** `phase14.test.ts`, planning lib unit tests

**`test:affected` demo phases:** 5, 6, 7, 8, 9, 10, 11, 11.1, 12, 13, 14

**Not required on every change:** full Phase 5–13 if only planning UI copy changes — use judgment via dependency map

**DB acceptance:** gate-only, separate org (`Teller Phase 14 Demo`)

---

## 29. Implementation slices

| Slice | Deliverable | Depends on |
|-------|-------------|------------|
| **14A** | Migration 032 design doc + settings + budget CRUD/version UI | — |
| **14B** | Budget approve/lock/clone + CSV import/export + audit | 14A |
| **14C** | Budget vs actual reporting + variance engine | 14B, Phase 10 |
| **14D** | Forecast entity + assumption engine + rolling P&L | 14B |
| **14E** | Publish/immutable forecast versions | 14D |
| **14F** | Cash forecast adapters (AR, AP) | 14E, Phase 5/6 |
| **14G** | Cash adapters (payroll, recurring, inventory, capex) | 14F, Phase 11–13 |
| **14H** | Scenarios + comparison reports | 14E, 14G |
| **14I** | Dashboard cards + owner mode labels | 14C, 14H |
| **14J** | Accountant package + close informational findings | 14C, 14H |
| **14K** | Controlled demo + DB acceptance harness | all |
| **14L** | Production finalization | 14K |

Each slice: `test:phase` → `test:affected` → slice complete. Full gate at 14L only.

---

## 30. Deferred to future

- Department/class/location budget dimensions
- ML forecasting
- Excel import/export
- Daily cash grain
- Auto-refresh scheduler for forecasts
- Multi-entity consolidation
- Tax planning scenarios
- Statistical customer payment behavior
- Budget approval workflows with multi-level approvers
- Capital planning beyond manual capex lines

---

## 31. Risks

| Risk | Mitigation |
|------|------------|
| Cash double-counting (AP/GRNI/PO) | Strict precedence adapter + acceptance suite |
| Performance on large COA | Snapshot materialization + RPC actuals |
| User confusion (plan vs actual) | Owner mode labels + immutable published versions |
| Scope creep into FP&A | Product simplicity review gate per slice |
| Forecast stale after close | Stale flag + refresh UX, not silent rewrite |

---

## 32. Open decisions vs recommendations

| Decision | Recommendation |
|----------|----------------|
| Weekly vs monthly cash only | **Weekly detail + monthly summary** |
| Job_id on org budget lines | **Optional V1** — keep job budgets separate |
| Scenario result persistence | **Cache on publish/compare** — optional table |
| Separate planning app section vs reports | **`/app/planning` hub** + report routes |
| Budget approval roles | **Owner/admin only V1** — match existing role model |
| Integration with cash-basis P&L (deferred Phase 10.1) | **Defer** — accrual actuals for planning V1 |

---

## 33. Migration 032 plan (design only — DO NOT APPLY)

**MIGRATION_032_REQUIRED = true**

File: `supabase/migrations/032_phase14_planning.sql`

Contents:

1. Enums: `teller_budget_version_status`, `teller_forecast_version_status`, `teller_planning_flow_kind`, etc.
2. Tables listed in §21
3. RLS policies (member read / writer manage)
4. Indexes listed in §21
5. FK constraints with `ON DELETE CASCADE` from org
6. RPCs: publish/approve/clone (4 functions)
7. **No** changes to journal tables, `teller_post_journal`, or existing phase RPCs
8. **No** backfill required — greenfield planning data
9. Optional seed: system scenario templates (Base/Downside/Upside) created on first forecast via app, not migration

Patch policy: if RPC hotfix needed post-apply, use `supabase/patches/032-*` manual apply pattern from Phase 13.

---

## 34. Build readiness checklist

- [x] Product scope defined
- [x] Accounting boundary explicit
- [x] Data model aligned to Teller conventions
- [x] Cash precedence rules defined
- [x] No GL mutation paths
- [x] RLS / tenant plan
- [x] Performance strategy
- [x] Acceptance test plan
- [x] Test tier integration
- [x] Implementation slices
- [x] Migration 032 outlined
- [x] HFAC boundary preserved

**PHASE_14_BUILD_READY = true**  
**PHASE_14_STARTED = false**
