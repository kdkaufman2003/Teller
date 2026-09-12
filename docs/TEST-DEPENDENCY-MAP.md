# Teller test dependency map

This map drives `npm run test:affected` and documents which historical suites to rerun when shared accounting modules change.

**Rules preserved:** double-entry, immutable journals, period locks, tenant isolation, idempotency, HFAC hard boundary, **manual migration only**. DB acceptance (`accept:phaseN:controlled`) is never part of the fast loop.

## Tier overview

| Tier | Command | Purpose |
|------|---------|---------|
| 1 | `npm run test:fast` | Scoped unit tests + typecheck, no DB |
| 2 | `npm run test:phase` | Current phase unit + verify + logic matrix |
| 3 | `npm run test:affected` | Current phase + dependency regressions |
| 4 | `npm run test:full` | All unit tests + build + all phase demos |
| Release | `npm run verify:deploy` | Pre-production gates (optional DB acceptance via env) |

Set active phase: `TELLER_TEST_PHASE=14 npm run test:phase` (defaults to **13**).

## Module → regression dependencies

### Shared journal engine

**Code:** `src/lib/accounting/post.ts`, atomic RPC wrappers (`inventory/atomic-rpc.ts`, payroll atomic RPCs), all `teller_post_journal` callers.

**Rerun demos:** Phase 5–13 (any journal mutation path)

**Unit tests:** `post.test.ts`, `integrity.test.ts`

---

### Period lock / close engine

**Code:** `src/lib/accounting/periods.ts`, close readiness (`evaluateCloseReadiness`), inventory close findings (`inventory/close-integration.ts`, `inventory/grni/close-integration.ts`).

**Rerun demos:** Phase 9, 13 (inventory close findings). Phase 5/11 only when lock engine itself changes.

**Unit tests:** `periods.test.ts`

---

### AP / purchasing

**Code:** bills, POs, vendor credits, GRNI bill settlement (`inventory/bill-integration.ts`, `inventory/grni/*`).

**Rerun demos:** Phase 6, 11.1, 13

**Unit tests:** `phase6-ap.test.ts`, `phase4.test.ts`

---

### Job costing

**Code:** `job-profitability.ts` (includes `inventoryMaterialCost`), job allocation, material issue/return economics.

**Rerun demos:** Phase 7, 13 (material issue/return). Phase 12 only when payroll/labor modules change.

**Unit tests:** `job-profitability.test.ts`

---

### Banking

**Code:** `src/lib/banking/*` — match, transfer, categorize. No inventory/GRNI economics.

**Rerun demos:** Phase 5, 6

**Unit tests:** `src/lib/banking/**/*.test.ts`

---

### Fixed assets

**Code:** `fixed-asset-*`, depreciation RPCs. Independent of inventory.

**Rerun demos:** Phase 8 only (unless shared journal engine changed)

**Unit tests:** `fixed-asset-*.test.ts`

---

### Payroll / labor

**Code:** `phase12.test.ts`, payroll services, labor entries.

**Rerun demos:** Phase 12, 7

**Unit tests:** `phase12.test.ts`

---

### Subledger automation (schedules)

**Code:** Phase 11 prepaid/accrual/deferred, Phase 11.1 settlement.

**Rerun demos:** Phase 11, 11.1, 9

**Unit tests:** `phase11.test.ts`, `phase11-1.test.ts`

---

### Financial reporting / accountant package

**Code:** `financial-reports.ts`, `phase10.test.ts`, inventory reporting (`inventory/reporting.ts`, `inventory/grni/reporting.ts`).

**Rerun demos:** Phase 10, 9, 13

**Unit tests:** `phase10.test.ts`, `financial-reports.test.ts`

---

### Inventory + GRNI (Phase 13)

**Code:** `src/lib/accounting/inventory/**`, migration 031 RPCs, receipt/bill allocations.

**Rerun demos:** Phase 13, 6, 7, 9, 10, 11.1

**Unit tests:** `phase13.test.ts`

**DB acceptance (gate only):** `npm run accept:phase13:controlled` — 70 scenarios, separate from fast loop.

---

### Planning / budgets (Phase 14)

**Code:** `src/lib/planning/**` — budgets, settings, audit. No GL mutation paths.

**Primary dependencies:** Phase 9 (fiscal year semantics), Phase 10 (future budget vs actual GL alignment).

**Rerun demos:** Phase 9, 10 only when planning touches fiscal/report interfaces.

**Unit tests:** `src/lib/planning/budgets/phase14.test.ts`, `phase14b.test.ts`, `src/lib/planning/reports/phase14c.test.ts`, `phase14d.test.ts`, `phase14e.test.ts`, `phase14f.test.ts`, `phase14g.test.ts`, `phase14h.test.ts`, `phase14i.test.ts`, `phase14j.test.ts`

**14K final gate:** `scripts/controlled-phase14-db-acceptance.ts` (106 scenarios incl. cross-module consistency, cash weekly reconciliation, missing/partial data) · `npm run verify:phase14:planning` · `npm run snapshot:phase14:production pre-deploy` · `npm run test:full`

**Primary dependencies (14F–14G cash):** Phase 1/2 (AR/AP), Phase 5 (bank/cash GL), Phase 6 (AP/purchasing), Phase 8 (fixed assets — capex semantics only), Phase 11 (recurring bills), Phase 12 (payroll), Phase 13 (GRNI/PO), Phase 10 (money utilities), Phase 14 settings.

**DB acceptance (gate only):** `npm run accept:phase14:controlled` — 69 scenarios after migration 032 + patches `032-phase14d-forecast-lines.sql` and `033-phase14f-cash-forecast.sql` applied manually.

---

## Phase → primary modules

| Phase | Primary modules | `test:affected` demo phases (Phase 13 active) |
|-------|-----------------|-----------------------------------------------|
| 5 | banking | 5, 6 |
| 6 | ap_purchasing, banking | 5, 6, 7, 11.1, 13 |
| 7 | job_costing | 7, 12, 13, 6, 9, 10, 11.1 |
| 8 | fixed_assets | 8, 5, 9, 10, 11, 11.1, 12, 13 (via journal engine) |
| 9 | period_lock_close, financial_reporting | 5, 9, 10, 11, 13, 6, 7, 11.1 |
| 10 | financial_reporting | 9, 10, 13, 6, 7, 11.1 |
| 11 | subledger_automation, period_lock_close | 5, 9, 11, 11.1, 13, 6, 7, 10 |
| 11.1 | subledger_automation, ap_purchasing | 6, 9, 11, 11.1, 13, 7, 10 |
| 12 | payroll, job_costing | 7, 12, 13, 6, 9, 10, 11.1 |
| 13 | inventory_grni, ap, job_costing, close, reporting | **6, 7, 9, 10, 11.1, 13** |
| 14 | planning, period_lock_close, financial_reporting | **9, 10** |
| 15 | sales_tax | 15 (15A foundation + 15B calculation engine) |
| 16 | shared_journal_engine | 16 (16A legal entity foundation — no demo yet) |

Configuration source: `scripts/test-tier-config.mjs`

### Phase 15 sales tax (15A–15H)

**Code:** `src/lib/accounting/tax/**`, `tax-rules/state-packs/*.json`, `POST /api/tax/calculate`, `POST /api/tax/state-packs/activate`.

**Unit tests:** `phase15a.test.ts` … `phase15h.test.ts`

**Verify:** `verify:phase15:tax`, `verify:migration:035:controlled`, `verify:migration:037:controlled`, `verify:migration:038:controlled`

**DB acceptance:** `accept:phase15:controlled` (111 scenarios — 15A–15J baseline + 12×15K final E2E + HFAC baseline)

**Tax reports (15I):** `src/lib/accounting/tax/reports/**`, `GET /api/reports/tax/*` — read-only; depends on subledger + filing + payments schema (035/037/038).

**Owner tax overview (15J):** `src/lib/accounting/tax/owner/**`, `GET /api/tax/overview`, `TaxOverviewView` — read-only; depends on 15F filing periods, 15G payments, 15I reports (no new schema).

**Manual reference data (15H):** `npm run tax-rules:load-state-packs` — loads global rate components; org activation is separate via API/acceptance.

### Phase 16 multi-entity (16A + 16B)

**Code:** `src/lib/accounting/legal-entity/**`

**Migrations (manual apply):**
- `040_phase16a_legal_entity_foundation.sql` — applied
- `041_phase16b_entity_access.sql` — applied

**Unit tests:** `phase16a.test.ts`, `phase16b.test.ts`

**Static verify:** `verify:phase16:multi-entity`

**Production schema probes (after manual apply):**
- `verify:migration:040:controlled`
- `verify:migration:041:controlled`

**DB acceptance:**
- `accept:phase16:controlled` (11 × 16A)
- `accept:phase16b:controlled` (11 × 16B — requires `setup:phase16-demo-org` for controlled profile fixture)

## Parallelization policy

Controlled demos use **separate demo orgs** per phase. `test:affected` runs dependency demos in **parallel** (`TELLER_DEMO_PARALLEL=1` by default).

`test:full` runs all phase demos **sequentially** — parallel all-phase runs can stress the shared controlled DB and cause flaky failures (e.g. Phase 8 under full parallel load).

Do **not** parallelize:

- DB acceptance scenarios within the same org reset cycle
- Suites sharing idempotency keys on the same org
- HFAC org (never used for economic tests)

Set `TELLER_DEMO_PARALLEL=0` to force sequential demos.

## Controlled DB strategy

| Context | Command |
|---------|---------|
| Daily development | `test:fast`, `test:phase` |
| Module change with cross-phase risk | `test:affected` |
| Release / shared infrastructure | `test:full` or `verify:deploy` |
| Phase gate / RPC economic change | `accept:phaseN:controlled` |

Never auto-apply migrations. Never point fast tests at HFAC production org for writes.
