# Phase 15 Implementation — Sales Tax & Tax Accounting

**Slice:** 15A (foundation) + 15B (calculation) + 15C (exemptions) + 15D (invoice/credit tax posting) · **DB verified:** yes (migration 035 + patch 036 applied)

> **Permanent rule:** ALL Teller Supabase migrations and SQL patches are manually applied by the operator.

---

## CURRENT_TAX_ARCHITECTURE (audit)

### Existing tables (migration 008)

| Table | Purpose |
|-------|---------|
| `teller_tax_rule_sets` | Versioned reference rule packs (`tax-rules/`) |
| `teller_tax_jurisdictions` | Global jurisdiction keys |
| `teller_tax_rates` | Effective-dated rates per rule set |
| `teller_tax_rules` | Priority-ordered taxability rules (JSON conditions/actions) |
| `teller_tax_determinations` | Per org/document/line working determinations |

### Document / org fields

| Location | Fields |
|----------|--------|
| `teller_documents` | `subtotal`, `tax`, `total` |
| `teller_industry_settings.answers` | `collectTax`, `taxRate`, `taxMode` (`flat` \| `jurisdiction`) |
| `teller_parties` | 1099 vendor metadata (Phase 10 — not sales tax exemptions) |

### Application code

| Path | Role |
|------|------|
| `src/lib/tax/` | Phase 6 jurisdiction engine + flat fallback |
| `src/lib/accounting/post.ts` | Invoice → Sales Tax Payable GL line |
| `src/lib/accounting/bills.ts` | Purchase tax capitalization |
| `src/lib/accounting/sales-tax-summary.ts` | Phase 10 aggregate report |
| `POST /api/tax/preview` | Preview determinations |
| `POST /api/invoices` | Server tax calc + persistence |

### Gaps addressed by Phase 15

| Gap | 15A foundation |
|-----|----------------|
| No tax authorities / registrations | `teller_tax_authorities`, `teller_tax_registrations` |
| No composable rate components | `teller_tax_rate_components` |
| No org tax settings table | `teller_tax_settings` |
| No tax subledger | `teller_tax_transactions` + components |
| No immutable posted snapshots | `teller_tax_determination_snapshots` |
| No exemption schema | `teller_tax_exemptions` (foundation) |
| No org taxability overrides | `teller_taxability_rules` |
| Flat org rate only long-term | Canonical settings + rule precedence |

---

## 15A scope (implemented — code stage)

### Domain (`src/lib/accounting/tax/`)

| Module | Status |
|--------|--------|
| `types.ts` | Core Phase 15 types |
| `jurisdiction.ts` | Hierarchy validation + path |
| `rates.ts` | Effective dating, components, rounding |
| `categories.ts` | Generic reference categories |
| `taxability.ts` | Rule precedence + needs_review |
| `calculation-contract.ts` | `calculateTax()` contract (foundation — no live MO/KS rules) |
| `posting-contract.ts` | Posting plan boundary (no journals in 15A) |
| `inclusive.ts` | Tax-inclusive/exclusive primitives |
| `immutability.ts` | Posted history contract |
| `period-lock.ts` | Phase 9 close respect |
| `readiness.ts` | Setup status checks |
| `settings.ts` | Org settings parse/serialize |
| `provider.ts` | `TaxDeterminationProvider` interface |
| `tenant-isolation.ts` | Cross-org rejection helpers |
| `audit.ts` | Config audit event types |
| `labels.ts` | Owner vs accountant labels |

### Migration 035 (prepared — NOT applied)

`supabase/migrations/035_phase15_tax_accounting.sql`

- Extends `teller_tax_jurisdictions` (parent, type)
- New: authorities, rate components, settings, registrations, categories, taxability rules, exemptions
- New: tax transactions, transaction components, determination snapshots, audit events
- RLS + cross-org guards + posted immutability triggers
- **Does not** modify `teller_post_journal`

### UI / API

| Route | Purpose |
|-------|---------|
| `/app/settings/tax` | Tax Setup foundation (readiness + liability account) |
| `GET/PATCH /api/settings/tax` | Org tax settings |

### Tooling

| Script | Purpose |
|--------|---------|
| `npm run verify:phase15:tax` | Static migration/code verify |
| `npm run accept:phase15:controlled` | DB acceptance (after manual 035) |

### Tests

- `src/lib/accounting/tax/phase15a.test.ts` — jurisdiction, rates, precedence, rounding, isolation, contracts

---

## 15A close gate (code stage)

```
PHASE_15_STARTED = true
PHASE_15A_STARTED = true
PHASE_15A_CODE_COMPLETE = true
PHASE_15A_DB_VERIFIED = true
PHASE_15A_COMPLETE = true

MANUAL_MIGRATION_REQUIRED = false
MANUAL_MIGRATION_FILE = supabase/migrations/035_phase15_tax_accounting.sql (applied)

PHASE15A_JOURNALS_CREATED = 0
TELLER_POST_JOURNAL_CHANGED = false
HFAC_MODIFIED = false
```

---

## 15A DB verification (2026-09-09)

| Gate | Result |
|------|--------|
| `verify:migration:035:controlled` | **PASS** |
| `accept:phase15:controlled` | **6/6 PASS** |
| HFAC baseline | 8 docs, 16 journals — unchanged |
| Journals created | **0** |
| `teller_post_journal` | unchanged |

Phase 15B may begin when ready. Do not deploy Phase 15 to production until slice 15L gate.

---

## 15B scope (implemented — calculation engine)

### Domain (`src/lib/accounting/tax/calculation/`)

| Module | Purpose |
|--------|---------|
| `engine.ts` | Pure `calculateTax(input, config)` — line-level taxability, rate composition, inclusive/exclusive |
| `rules.ts` | Org rule matching + precedence integration |
| `rate-resolution.ts` | Effective-dated multi-component rate resolution |
| `location.ts` | Deterministic location precedence (transaction → service → ship-to → customer → seller) |
| `category.ts` | Explicit tax category resolution (no ML / no description guessing) |
| `money.ts` | Exact-cent helpers (`toCents`, `taxFromBasisCents`) |
| `reason-codes.ts` | Machine-readable needs-review codes |
| `snapshot.ts` | Determination snapshot serialization for 15D |
| `load-config.ts` | Server-side org config loader |
| `persist.ts` | Optional draft snapshot persistence (not used by preview/API) |

| Service | Purpose |
|---------|---------|
| `calculate-for-org.ts` | `calculateTaxForOrganization(supabase, orgId, input)` — org from auth context |
| `POST /api/tax/calculate` | Read-only preview calculation (no DB mutation) |

### Calculation contract

- **Input:** transaction date, location sources, customer/exemption placeholder, lines (amount, category, overrides, tax-inclusive flag)
- **Output:** document status, subtotals, line results, jurisdiction components, warnings, reason codes, `teller_tax_engine_v1` metadata
- **Rule precedence:** line override → customer exemption → org override → industry default → reference rule → needs_review
- **Rate resolution:** transaction-date effective ranges; ambiguous overlapping rates → needs_review
- **Rounding:** uses Phase 15A `per_line` / `per_component` / `per_document` policy with cent-safe arithmetic
- **Tax-inclusive:** derives pre-tax basis + tax without inflating line total; multi-component allocation by rate share
- **No posting:** calculation does not create journals or immutable tax transactions

### Tests

| File | Coverage |
|------|----------|
| `phase15b.test.ts` | Basic/mixed lines, multi-component, effective dates, precedence, rounding, ambiguity, snapshots, tenant isolation |
| `controlled-phase15-db-acceptance.ts` | +10 DB scenarios (taxable, multi-component, effective date, mixed doc, needs-review, ambiguous rate, inclusive, tenant isolation, zero journals, preview no persist) |

### 15B close gate (2026-09-09)

```
PHASE_15B_CODE_COMPLETE = true
PHASE_15B_DB_VERIFIED = true
PHASE_15B_COMPLETE = true

FAST_TESTS = PASS (246/246)
PHASE15_TESTS = PASS (39/39)
AFFECTED_TESTS = PASS (304/304)
PHASE15_CONTROLLED_ACCEPTANCE = PASS (16/16)
verify:phase15:tax = PASS
PHASE15B_JOURNALS_CREATED = 0
TAX_PREVIEW_DB_MUTATION = false
NEW_MIGRATION_REQUIRED = false
MANUAL_PATCH_REQUIRED = false
```

---

## CURRENT_EXEMPTION_ARCHITECTURE (migration 035)

| Field / concept | 035 support |
|-----------------|-------------|
| Party association | `party_id` → `teller_parties` |
| Certificate number | `certificate_number` |
| Certificate type | `metadata.certificateType` |
| Issuing jurisdiction | `metadata.issuingJurisdictionKey` |
| Jurisdiction scope | `jurisdiction_scope` jsonb array |
| Category scope | `category_scope` jsonb array |
| Effective / expiration | `effective_from`, `effective_to` |
| Status | `status` (`active`, `inactive`, `pending`, `expired`) |
| Review metadata | `metadata.reviewStatus`, `metadata.rejectedAt` |
| Attachment reference | `metadata.attachmentStoragePath`, `certificate_on_file` |
| Notes / source | `metadata.notes`, `metadata.source` |
| Audit lineage | `created_by`, `teller_tax_audit_events` |
| Snapshot link | `teller_tax_determination_snapshots.exemption_id` |

**No new migration required for 15C** — metadata carries certificate type, review, revocation, and attachment references.

---

## 15C scope (implemented — exemption certificates)

### Domain (`src/lib/accounting/tax/exemptions/`)

| Module | Purpose |
|--------|---------|
| `resolver.ts` | `resolveCustomerExemption()` — validity, scope, ambiguity |
| `scope.ts` | Jurisdiction + category scope matching |
| `validity.ts` | Date validity + expiration warnings |
| `service.ts` | CRUD, activate, revoke, duplicate detection |
| `load.ts` | Org/party exemption loaders |

### Calculator integration

- `calculateTaxForOrganization()` loads party exemptions when `customer.partyId` is present
- Engine calls resolver per line (jurisdiction + category) — no duplicated exemption logic in `calculateTax()`
- Expired/revoked/out-of-scope certificates **fall through** to normal tax rules; ambiguous/incomplete → `needs_review`

### API / UI

| Route | Purpose |
|-------|---------|
| `GET/POST /api/tax/exemptions` | List/create |
| `GET/PATCH /api/tax/exemptions/[id]` | Read/update draft |
| `POST /api/tax/exemptions/[id]/activate` | Activate certificate |
| `POST /api/tax/exemptions/[id]/revoke` | Revoke with effective date |
| Customer detail | Tax Exemptions panel |
| `/app/settings/tax/exemptions` | Org exemption index |

## 15D scope (implemented — sales tax posting)

### Posting domain (`src/lib/accounting/tax/posting/`)

| Module | Purpose |
|--------|---------|
| `prepare.ts` | `calculateTaxForOrganization` + `planTaxPosting` gate |
| `open-invoice.ts` / `open-credit.ts` | Post document + persist tax subledger |
| `persist-transactions.ts` | `teller_tax_transactions` + components + snapshots |
| `reverse-transactions.ts` | Append-only subledger reversals on void |
| `open-document.ts` | Routes API posting through Phase 15 when schema ready |

### GL integration

- Invoice: Dr AR = subtotal + tax · Cr revenue lines · Cr **Sales & Use Tax Payable** (from `teller_tax_settings`)
- Credit memo: Dr revenue · Dr tax payable · Cr AR (proportional tax reversal)
- Payment/refund: **no additional tax GL** — liability recognized at sale post
- Reversal: existing `reverseJournalEntry` + tax subledger mirror rows

### Manual patch 036 (applied)

Migration 035 trigger `teller_guard_tax_transaction_org` was corrected via `supabase/patches/036_phase15d_tax_line_org_guard.sql`.

- **Static verify:** `node scripts/verify-patch-036-phase15d.mjs`
- **Production verify:** `node scripts/verify-patch-036-production.mjs`
- **`teller_tax_transactions.line_id`** persisted directly; snapshots + metadata retain lineage

### 15D close gate (2026-09-10)

```
PHASE_15D_CODE_COMPLETE = true
PHASE_15D_DB_VERIFIED = true
PHASE_15D_COMPLETE = true

FAST_TESTS = PASS (277/277)
PHASE15_TESTS = PASS (70/70)
AFFECTED_TESTS = PASS (335/335)
PHASE15_CONTROLLED_ACCEPTANCE = PASS (34/34 — 6×15A + 10×15B + 9×15C + 9×15D)
TARGETED_LINT = PASS
TELLER_POST_JOURNAL_CHANGED = false
HFAC_BASELINE_UNCHANGED = true
MANUAL_PATCH_REQUIRED = false (036 applied)
```

### Phase 15E — Purchasing + use tax (2026-09-10)

**Purchase tax model:** Reuses Phase 15B calculator with `transactionType: bill`. Explicit `vendorTaxCharged` (bill `tax` field) is compared to required tax via `comparePurchaseTax()`. `useTaxDue = max(required − vendor, 0)` per line/component; vendor overage never creates negative use tax.

**Vendor-charged tax:** Posted through existing `allocateVendorPurchaseTax()` — capitalized into expense/asset or input-tax asset; never credited to Sales & Use Tax Payable. AP = subtotal + vendor tax only.

**Use tax accrual:** When `useTaxDue > 0`, additional journal lines debit the economic destination (use tax expense account for expense lines; line asset account for inventory/fixed asset) and credit configured Sales & Use Tax Payable. Use tax does not increase AP.

**GRNI / PPV boundary:** Phase 15E bill posting does not alter GRNI settlement paths. Use tax is not routed through PPV. Inventory quantity unchanged.

**Subledger:** `use_tax_accrued` rows + immutable snapshots with required/vendor/use tax metadata. Bill void appends `tax_adjustment` reversal rows (append-only).

**Key modules:**
- `src/lib/accounting/tax/purchase/` — comparison, classification, use-tax journal builder
- `src/lib/accounting/tax/posting/open-bill.ts` — `postBillOpenWithPhase15Tax`
- `src/lib/accounting/tax/posting/prepare-purchase.ts`
- `src/lib/accounting/tax/posting/persist-purchase-tax.ts`
- `bill-approval.ts` → `openBillDocument`

**Schema:** Migration 035 + patch 036 sufficient. `NEW_MIGRATION_REQUIRED = false`.

### 15E close gate (2026-09-10)

```
PHASE_15E_CODE_COMPLETE = true
PHASE_15E_DB_VERIFIED = true
PHASE_15E_COMPLETE = true

FAST_TESTS = PASS (293/293)
PHASE15_TESTS = PASS (86/86)
PHASE15_CONTROLLED_ACCEPTANCE = PASS (45/45 — +11×15E)
TARGETED_LINT = PASS
TELLER_POST_JOURNAL_CHANGED = false
HFAC_BASELINE_UNCHANGED = true
NEW_MIGRATION_REQUIRED = false
MANUAL_PATCH_REQUIRED = false
```

### Phase 15F — Filing periods + liability reconciliation (2026-09-11)

**Goal:** Answer “what sales/use tax liability belongs to a filing period, and does the tax subledger reconcile to GL?” Phase 15F does **not** file returns or post authority payments (15G).

**Schema (prepared — manual apply):** `supabase/migrations/037_phase15f_tax_filing_periods.sql`
- `teller_tax_filing_periods` — org + registration + authority/jurisdiction + date range + frequency + status
- `teller_tax_filing_period_snapshots` — append-only reconciliation/reviewed/filed payloads
- Org guard trigger; RLS; filed snapshot immutability trigger

**Filing period model:** Registration-driven only. Periods derive from active `teller_tax_registrations` (`filing_frequency`, `effective_from`/`effective_to`). No periods for orgs with transactions but no registration. Status flow: `open` → `ready_for_review` → `reviewed` → `filed` → `closed` (plus `needs_review`).

**Period generation:** `generateFilingPeriodsForRegistration()` / `generateTaxFilingPeriods()` — monthly, quarterly, annual; idempotent upsert on `(org, registration, start, end)`.

**Liability rollforward:** `aggregateRollforward()` from immutable posted `teller_tax_transactions` by `transaction_date`:
- Sales: `sales_tax_collected`, credits/reversals, adjustments
- Use: `use_tax_accrued`, purchase reversals
- Excludes: `authority_payment`, vendor-charged purchase tax (never in use-tax liability)

**GL reconciliation:** `reconcileTaxPeriod()` compares subledger net to Sales & Use Tax Payable GL movement for the period. Surfaces `subledgerToGlDifference` and `glRollforwardDifference`. Exception codes: `GL_WITHOUT_TAX_SUBLEDGER`, `ORPHAN_TAX_SUBLEDGER`, `NEEDS_REVIEW_TAX_TRANSACTION`, etc.

**Readiness:** Blocked when reconciliation diff ≠ 0, needs_review transactions, overlap/gap, or unassigned registration/authority.

**Immutability:** Filed/closed periods preserve snapshots; later tax activity surfaces as exceptions — no historical rewrite.

**API/UI:**
- `GET/POST /api/tax/filing-periods`, `GET/PATCH /api/tax/filing-periods/[id]`
- Settings → Tax → Filing periods (`TaxFilingPeriodsView`, `TaxFilingPeriodDetailView`)

**Key modules:** `src/lib/accounting/tax/filing/` — `period-generation.ts`, `rollforward.ts`, `reconcile.ts`, `readiness.ts`, `service.ts`

**Tests:** `phase15f.test.ts` (16 unit). Controlled acceptance +8 scenarios when migration 037 applied.

**Accounting safety:** `PHASE15F_JOURNALS_CREATED = 0` — reconciliation only, no economic postings.

### Phase 6 demo regression (22/32) — classification

Investigated before 15F closeout. **Not an AP regression from Phase 15E.**

| Evidence | Interpretation |
|----------|----------------|
| PO/receipt/bill core path (9a–9f, 11) **pass** | AP posting engine works for fresh documents |
| Failures reference **BILL-1001**, remaining **$0** | Demo org accumulated settled bills across runs |
| C1 fails → C4/C5/C20 cascade (empty payment UUID) | Harness dependency on prior scenario fixtures |
| C3/C18 “exceeds remaining $0” | Credits applied to already-paid bills |
| C6/C7 closed-period rejections **pass** | Period lock intact |
| Phase 6 org has **no** `teller_tax_settings` configured | Phase 15E bill path inactive for demo org |
| HFAC baseline **pass** | No integration regression |

```
PHASE6_DEMO_22_OF_32_CLASSIFICATION = STALE_DEMO_STATE + HARNESS_IDEMPOTENCY_ISSUE
PHASE6_ACTUAL_REGRESSION = false
```

Optional harness reset deferred — does not block 15F.

### 15F close gate (2026-09-11, verified)

```
PHASE_15F_CODE_COMPLETE = true
PHASE_15F_DB_VERIFIED = true
PHASE_15F_COMPLETE = true

MIGRATION_037_MANUALLY_APPLIED = true
NEW_MIGRATION_REQUIRED = false
MANUAL_PATCH_REQUIRED = false

FAST_TESTS = PASS (309/309)
PHASE15_TESTS = PASS (102/102)
PHASE15_CONTROLLED_ACCEPTANCE = PASS (53/53 — +8×15F)
TARGETED_LINT = PASS
TELLER_POST_JOURNAL_CHANGED = false
PHASE15F_JOURNALS_CREATED = 0
UNBALANCED_PRODUCTION_JOURNALS = 0
HFAC_BASELINE_UNCHANGED = true
```

**Reconciliation fix:** GL comparison uses tax-payable movement from journal entries linked to registration-scoped posted tax transactions (not org-wide payable balance), enabling multi-registration orgs to reconcile per authority/jurisdiction.

### Phase 15G — Tax authority payments + adjustments (2026-09-11)

**Goal:** Record payments to tax authorities, allocate across filing periods, handle penalties/interest/overpayments, manual adjustments, and reversals — without automated government filing or cash initiation.

**Schema (prepared — manual apply):** `supabase/migrations/038_phase15g_tax_authority_payments.sql`
- `teller_tax_authority_payments` — payment header, journal link, idempotency, status
- `teller_tax_authority_payment_allocations` — multi-period subledger assignment (no duplicate GL)
- `teller_tax_manual_adjustments` — explicit liability adjustments with reason codes
- Extended `teller_tax_settings` — penalty, interest, overpayment accounts
- Extended `teller_tax_transactions` — registration/period/payment FKs

**Payment journal:**
- Base tax: Dr Sales & Use Tax Payable · Cr Cash
- Penalty/interest: Dr configured expense · Cr Cash (not payable reduction)
- Overpayment: Dr configured overpayment/receivable when allocation exceeds liability

**Rollforward (15F extended):** `authority_payment` reduces outstanding liability; payment reversals append-only via `tax_adjustment` metadata.

**API/UI:**
- `POST/GET /api/tax/authority-payments`, `POST .../[id]` (reverse, bank_match)
- `POST /api/tax/adjustments`
- Filing period detail: Tax due / Paid / Remaining + Record Payment

**Key modules:** `src/lib/accounting/tax/payments/`

### 15G close gate (pending full migration 038)

Production probe (2026-09-11): **038 is partially applied** — payment/adjustment/allocation tables exist, but the `ALTER TABLE` portions at the top of 038 (tax settings penalty/interest/overpayment columns + tax transaction registration/payment FKs) are not yet present. Re-run the full migration file (safe: `IF NOT EXISTS` / `create table if not exists`).

Acceptance until complete: `15G_SCHEMA_INCOMPLETE` (53/54 pass; 15A–15F unchanged).

Code fixes in closeout pass:
- `resolveSalesTaxPayableAccountId(settings, amount)` signature corrected in payment/adjustment paths
- Payment persistence failure auto-reverses orphan journal (best-effort)
- Penalty/interest/overpayment accounts fall back to `teller_tax_settings.metadata` when dedicated columns missing (dev only; production should use 038 columns)

```
PHASE_15G_CODE_COMPLETE = true
PHASE_15G_DB_VERIFIED = false (until migration 038 fully applied)
PHASE_15G_COMPLETE = false

NEW_MIGRATION_REQUIRED = true
MANUAL_PATCH_REQUIRED = true
MANUAL_PATCH_FILE = supabase/migrations/038_phase15g_tax_authority_payments.sql
```

### Phase 15H — Missouri + Kansas state configuration packs (2026-09-11)

**Goal:** Versioned MO/KS reference configuration packs that drive the generic Phase 15 tax engine — no forked calculator, no journals on activation.

**Architecture:** `tax-rules/state-packs/*.json` → `src/lib/accounting/tax/state-packs/` (registry, validation, sourcing, activation) → org registration + materialized taxability rules + global rate components.

**Packs:** `MO-2026.1` (origin/seller sourcing, state 4.225%), `KS-2026.1` (destination sourcing, state 6.50% + Finney County reference fixture 1.45%).

**Rate data V1 strategy:** State components from official sources; local components only for explicitly seeded reference jurisdictions; unknown county/city → `UNKNOWN_LOCAL_JURISDICTION` / `needs_review` (no silent state-only completion).

**HVAC:** Item-type → generic category mapping (`state-packs/industry/hvac-mapping.ts`); fact-dependent patterns → `needs_review`.

**API:** `GET /api/tax/state-packs`, `POST /api/tax/state-packs/activate`

**Reference data load (manual):** `npm run tax-rules:load-state-packs` (requires env; does not activate org packs)

**Source docs:** `docs/tax/MO-TAX-SOURCES.md`, `docs/tax/KS-TAX-SOURCES.md`

### Phase 15I — Tax reports + accountant package (2026-09-11)

**Goal:** Read-only accountant-grade reporting derived from posted tax subledger, filing periods, payments, and historical determination snapshots — no economic mutations.

**Architecture:** `src/lib/accounting/tax/reports/` — summary, rollforward, GL reconciliation (reuses `reconcileTaxPeriod`), sales/use detail, exemptions (snapshot-based), needs-review, payments, adjustments, jurisdiction/authority summaries, accountant package + README manifest.

**Date basis:** `transaction_date` on `teller_tax_transactions` (documented as `TAX_REPORT_DATE_BASIS`).

**API:** `GET /api/reports/tax?report=...`, `GET /api/reports/tax/accountant-package`

**UI:** `/app/reports/tax` (`TaxReportsView`) — owner summary cards + accountant CSV links/package download.

**CSV safety:** `neutralizeTaxCsvFormula` / `sanitizeTaxCsvCell` — formula-prefix neutralization before escaping.

**Large datasets:** Paginated detail reports (`paginateRows`); batched component/journal ID queries (`TRANSACTION_ID_BATCH_SIZE` / `JOURNAL_ENTRY_ID_BATCH_SIZE`).

**No schema migration required** — reports query existing Phase 15A–15G tables.

### Phase 15J — Owner tax dashboard + UX simplification (2026-09-11)

**Goal:** Owner-facing tax overview and simplified workflows — no tax engine, posting, or reconciliation logic changes.

**Architecture:** `src/lib/accounting/tax/owner/` — `getTaxOwnerSummary()` aggregates canonical Phase 15F/15G/15I services:
- **Tax owed:** sum of filing-period `remaining` balances (from reconciliation metadata + bounded `loadTaxPeriodPaymentSummary`)
- **Tax paid:** YTD `buildTaxPaymentReport` base tax amounts (excludes reversed/voided)
- **Next period:** `selectNextFilingPeriod()` — prioritizes unpaid filed periods, then review-ready periods
- **Needs attention:** `buildTaxAttentionItems()` — setup readiness, needs-review report, period exceptions, exemptions
- **Setup status:** reuses `loadTaxSettings` / `evaluateTaxReadiness`

**API:** `GET /api/tax/overview` — org from `requireBooks()`; presentation mode from CPA mode / role.

**UI:**
- `/app/settings/tax` — owner tax home (`TaxOverviewView`) with cards: Tax Owed, Tax Paid, Next Period, Needs Attention
- `/app/settings/tax/configure` — accountant settings (`TaxSettingsView`)
- `TaxNav` — Overview, Filing periods, Reports, Settings, Exemptions
- Filing period list/detail — owner columns (owed/paid/remaining/status); accountant GL/reconcile detail when CPA/bookkeeper mode

**Read-only dashboard:** overview load creates zero journals, payments, or adjustments.

**Due dates:** shown only when configured on period metadata; otherwise “Not configured” — no inferred state due dates.

**Reports linkage:** overview links to Phase 15I reports and accountant package download — no duplicate report math.

**No schema migration required.**

### 15J close gate (2026-09-11)

```
PHASE_15J_CODE_COMPLETE = true
PHASE_15J_DB_VERIFIED = true
PHASE_15J_COMPLETE = true
PHASE15_CONTROLLED_ACCEPTANCE = PASS (98/98 — 87 baseline + 11×15J)
PHASE15J_DASHBOARD_ACCOUNTING_MUTATIONS = 0
PHASE15J_JOURNALS_CREATED = 0
OWNER_TAX_OWED_USES_CANONICAL_TRUTH = true
OWNER_TAX_READINESS_USES_EXISTING_ENGINE = true
TAX_ENGINE_CHANGED_FOR_PHASE15J = false
NEW_MIGRATION_REQUIRED = false
```

---

## Phase 15 inventory (15A–15J)

| Slice | Capability | Canonical module | Mutates GL? |
|-------|------------|------------------|-------------|
| **15A** | Schema, settings, subledger foundation | `src/lib/accounting/tax/` | No (setup only) |
| **15B** | Tax calculation + snapshots | `calculation/engine.ts`, `calculate-for-org.ts` | No |
| **15C** | Exemptions | `exemptions/` | No |
| **15D** | Sales tax invoice/credit posting | `posting/open-invoice.ts`, `open-credit.ts` | Yes |
| **15E** | Purchase/use tax posting | `posting/open-bill.ts`, `purchase/` | Yes |
| **15F** | Filing periods + reconciliation | `filing/` | No |
| **15G** | Authority payments + adjustments | `payments/` | Yes |
| **15H** | MO/KS state packs | `state-packs/`, `tax-rules/state-packs/` | No |
| **15I** | Reports + accountant package | `reports/` | No |
| **15J** | Owner tax dashboard | `owner/`, `TaxOverviewView` | No |

**Single accounting truth:** one tax subledger (`teller_tax_transactions`), one GL payable control account, one rollforward/reconcile path (`filing/reconcile.ts`), one report layer (`reports/`).

**Single determination engine:** `calculateTax()` in `calculation/engine.ts` via `calculateTaxForOrganization()` — no parallel engines.

### Phase 15K — Final acceptance + release candidate (2026-09-11)

**Goal:** End-to-end validation of Phase 15A–15J; no new features unless release-blocking.

**Added:** 12 controlled DB scenarios (`15K_*`) covering E2E sales tax, exempt, needs-review, use tax, filing period, payment, report reconciliation, accountant package, owner dashboard, historical immutability, tenant isolation, control-account GL, unbalanced journal check.

**Release notes:** `docs/PHASE-15-RELEASE-NOTES.md`

**Gates run:** static verify, fast, phase, build, controlled acceptance (111/111). Full/affected demo suites: Phase 6 AP harness state (22/32) — classified HARNESS_STATE, not Phase 15 regression.

**HFAC baseline (investigated 2026-09-11):** journals 17 (was 16) — +1 Stripe payment journal for INV-1006 on HFAC live org; Phase 15 acceptance does not write to HFAC.

**No schema migration required.**

### 15K / Phase 15 close gate (2026-09-11)

```
PHASE_15K_CODE_COMPLETE = true
PHASE_15K_DB_VERIFIED = true
PHASE_15K_COMPLETE = true
PHASE_15_COMPLETE = true
PHASE15_CONTROLLED_ACCEPTANCE = PASS (111/111)
MO_KS_PRODUCTION_REFERENCE_DATA_LOADED = true
NEW_MIGRATION_REQUIRED = false
```

### 15L scope (production deploy + post-deploy verification)

**Completed:** 2026-09-11  
**Release commit:** `71942a41e743e706273e316274946b8921b80b60`  
**Production URL:** `https://teller-indol.vercel.app`  
**Vercel deployment:** `HhrjMrgJBizfyMjzcMTRfsddCrmy` (GitHub status success on release SHA)

| Gate | Result |
|------|--------|
| Pre-deploy snapshot | PASS — `artifacts/controlled-prod-snapshots/pre-phase15-deploy-2026-09-11T23-32-23-590Z.json` |
| Push release commit to `main` | PASS — auto-deploy triggered |
| Deployed SHA = release SHA | PASS |
| Production smoke (tax routes + APIs) | PASS — `npm run verify:phase15:production-smoke` |
| Post-deploy schema probes (035/037/038) | PASS |
| Post-deploy snapshot | PASS — `artifacts/controlled-prod-snapshots/post-phase15-deploy-2026-09-11T23-36-36-950Z.json` |
| Pre/post HFAC diff | **0** (8 docs, 17 journals, 0 HFAC tax rows) |
| Global journals balanced | PASS (1487 entries, 0 unbalanced) |
| MO/KS reference loader | PASS — `us-mo-sales-tax-v1@MO-2026.1`, `us-ks-sales-tax-v1@KS-2026.1` |
| Deploy accounting writes | 0 on HFAC |
| Migrations/SQL auto-applied | **false** |

**Rollback criteria:** revert Vercel to prior SHA if HFAC counts change, journals unbalanced, tax smoke fails, or schema probes fail. DB is forward-only (manual migrations only).

See [PHASE-15-COMPLETION.md](./PHASE-15-COMPLETION.md).

### 15L close gate (2026-09-11)

```
PHASE_15L_STARTED = true
PHASE_15L_COMPLETE = true
PRODUCTION_DEPLOYED_FOR_PHASE15 = true
MO_KS_PRODUCTION_REFERENCE_DATA_LOADED = true
HFAC_BASELINE = 8 documents / 17 journals
UNBALANCED_PRODUCTION_JOURNALS = 0
```

### 15I close gate (2026-09-11)

```
PHASE_15I_CODE_COMPLETE = true
PHASE_15I_DB_VERIFIED = true
PHASE_15I_COMPLETE = true
PHASE15_CONTROLLED_ACCEPTANCE = PASS (87/87 — 74 baseline + 13×15I)
PHASE15I_JOURNALS_CREATED = 0
NEW_MIGRATION_REQUIRED = false
```

### 15H close gate (2026-09-11)

```
PHASE_15H_CODE_COMPLETE = true
PHASE_15H_DB_VERIFIED = true
PHASE_15H_COMPLETE = true

STATE_PACK_ARCHITECTURE = PASS
STATE_PACK_VERSIONING = PASS
MO_STATE_PACK = PASS (MO-2026.1)
KS_STATE_PACK = PASS (KS-2026.1)
PHASE15_CONTROLLED_ACCEPTANCE = PASS (74/74 — 63 baseline + 11×15H)
PHASE15H_JOURNALS_CREATED = 0
NEW_MIGRATION_REQUIRED = false
MANUAL_PATCH_REQUIRED = false (reference data via `npm run tax-rules:load-state-packs`)
```

**Regression fixes during 15H closeout:**
- State pack profile selection prefers transaction-facing location over implicit org seller.
- Taxability/rate resolution: exact jurisdiction beats prefix reference (prevents MO/KS pack pollution of acceptance keys).
- Filing reconciliation batches large `entry_id` IN queries (fixes `fetch failed` with accumulated demo journals).

### 15C close gate (2026-09-09, verified 2026-09-10)

```
PHASE_15C_CODE_COMPLETE = true
PHASE_15C_DB_VERIFIED = true
PHASE_15C_COMPLETE = true

FAST_TESTS = PASS (266/266)
PHASE15_TESTS = PASS (59/59 — 15A + 15B + 15C unit)
AFFECTED_TESTS = PASS (324/324)
PHASE15_CONTROLLED_ACCEPTANCE = PASS (25/25 — 6×15A + 10×15B + 9×15C)
TARGETED_LINT = PASS
EXEMPTION_CONFIG_MUTATES_ACCOUNTING = false
HISTORICAL_TAX_AUTO_RECALC = false
PHASE15C_JOURNALS_CREATED = 0
NEW_MIGRATION_REQUIRED = false
MANUAL_PATCH_REQUIRED = false
```

**Acceptance hardening:** `15C_VALID_EXEMPTION_RESOLVES` and `15C_HISTORICAL_SNAPSHOT_IMMUTABLE` now use isolated parties and fetch exemptions by insert ID so prior runs cannot leave expired certificates on shared demo parties.

- **15G:** Tax authority payment posting
- **15H:** MO/KS reference rule packs
