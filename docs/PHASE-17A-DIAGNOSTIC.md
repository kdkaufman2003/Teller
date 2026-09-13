# Phase 17A — Full System Diagnostic & Accounting Integrity Audit

**Date:** 2026-09-12  
**Slice:** 17A (audit-first; feature freeze)  
**Production baseline:** Phase 16J closed — migrations 040–047, patches 048–050 applied  
**Release commit:** `edc0dc6a1f27cf824f2c7cc357cfa6b89e1b86d3`

---

## Executive Summary

Phase 17A performed an independent re-verification of Teller accounting integrity across the full application surface after Phase 16 close. **No critical accounting blockers were found in production.** All production journals balance; HFAC baseline unchanged; canonical posting paths are intact.

Primary residual risks are **not** broken double-entry in production, but rather:

1. **Presentation-layer truth duplication** (`amount_paid` cache vs allocation subledger vs GL-derived totals) — controlled by hierarchy but can confuse reports/dashboards if cache drifts.
2. **Security hardening gaps** (entity-level RLS depth, legacy zero-membership, journal INSERT policy re-enabled in 047) — deferred to 17B.
3. **Operational reliability gaps** (idempotency/concurrency on retryable paths) — deferred to 17C.
4. **Jobs remain org-scoped** by design — entity isolation relies on journal/account linkage, not job rows.

**Verdict:** Phase 17A audit complete. Teller is **not launch-ready** (17B–17H remain). No DB migration required for 17A closeout.

---

## Production Baseline

| Metric | Value |
|--------|-------|
| Supabase project | `ypixbxicdecwfafculha` |
| Production URL | https://teller-indol.vercel.app |
| HFAC documents | 8 |
| HFAC journals | 17 |
| HFAC modified by 17A | false |
| Migrations applied | 040–047 |
| Patches applied | 048, 049, 050 |

---

## Accounting Truth Map

| Concept | Authoritative Source | Denormalized Cache? | Reconciliation Required? | Can Be Rebuilt? |
|---------|---------------------|---------------------|--------------------------|-----------------|
| GL balance | `teller_journal_lines` aggregated by account | No | N/A | Yes (from journals) |
| AR open balance (control) | Allocation subledger + `subledger.ts` control accounts | `amount_paid` on documents | Yes — `integrity.ts`, close readiness | Yes (from allocations + GL) |
| AP open balance (control) | Same as AR for expense/bill kinds | `amount_paid` | Yes | Yes |
| Cash (GL) | Cash/bank GL accounts via journal lines | Bank feed balances | Yes — bank reconciliation | Yes |
| Bank reconciliation | `teller_bank_reconciliations` + matched transactions | Provider balance | Yes | Partial |
| Customer deposits | Deposit allocations + GL deposit liability account | Dashboard may use GL | Yes — `deposit-reconciliation.ts` | Yes |
| Customer credits | `teller_document_allocations` + credit memo journals | Payment allocation kinds in SQL | Yes | Yes |
| Vendor credits | Document + allocation subledger | `amount_paid` | Yes | Yes |
| Inventory | `teller_inventory_balances` + GL inventory accounts | WAC cache | Yes — `inventory/reconciliation.ts` | Yes |
| GRNI | GRNI GL + open receipt value | Receipt line totals | Yes — `grni/reconciliation.ts` | Yes |
| Fixed assets | Asset register + depreciation schedules → GL | Book value on asset row | Yes | Yes |
| Accumulated depreciation | GL contra-asset + schedule | Asset row cache | Yes | Yes |
| Sales tax payable | Tax liability accounts + authority payments | Tax line caches | Yes — Phase15 reports | Yes |
| Payroll liabilities | Payroll run journals | Run totals | Yes | Yes |
| Intercompany due-to/from | Paired IC journals per entity | Open items table | Yes — `intercompany/reconciliation.ts` | Yes |
| Eliminations | `teller_consolidation_elimination_entries` (not entity books) | Worksheet cache | Yes — consolidated reports | Yes |
| Planning data | Planning tables (non-GL) | Report caches | No GL tie | N/A |

**Hierarchy (document payments):** allocations → legacy payment link → GL-derived → `amount_paid` cache (`balances.ts`).

**DUPLICATE_ACCOUNTING_TRUTH_SOURCES:** `false` for control/close reconciliation (single canonical hierarchy). Presentation layers may read cache — see finding 17A-001.

---

## Posting Path Inventory

| Classification | Count | Notes |
|----------------|-------|-------|
| CANONICAL | 1 | 8-arg `teller_post_journal` (migration 042) via `postJournal()` |
| LEGACY_WRAPPER | 1 | 7-arg overload (patch 049) — delegates to 8-arg |
| CONTROLLED_EXCEPTION | ~34 | SQL RPCs in banking, deposits, inventory, payroll, IC, eliminations, tax, etc. — all invoke canonical post internally |
| UNSAFE (production `src/`) | 0 | No direct journal INSERT/UPDATE/DELETE in app code |
| UNSAFE (demo scripts only) | 2+ | Controlled demo runners — test fixtures only |

**UNSAFE_GL_POSTING_PATHS:** 0 (production)

---

## Integrity Results

| Check | Result |
|-------|--------|
| UNBALANCED_PRODUCTION_JOURNALS | 0 |
| POSTED_JOURNAL_MUTATION_PATHS (src) | 1 — fixed-asset line metadata UPDATE only (17A-013); no entry INSERT/UPDATE/DELETE |
| POSTED_HISTORY_IMMUTABILITY | PASS (economic) — debit/credit immutable; metadata tag exception on FA link |
| DOCUMENT_JOURNAL_TRACEABILITY | PASS — `source_kind`/`source_id` on entries; gaps noted for manual journals only |
| CLOSED_PERIOD_POSTING_BYPASS | false — `teller_books_closed_through` + entity scope |
| ENTITY_CLOSE_ISOLATION | PASS |
| ONE_JOURNAL_ONE_ENTITY | true |
| CROSS_ENTITY_ACCOUNT_POSTING | false (DB trigger + validation) |
| CROSS_ENTITY_PAYMENT_ALLOCATION | false |
| BANK_ACCOUNT_SINGLE_ENTITY | true |
| PERIOD_SINGLE_ENTITY | true |
| ALL_COMPANIES_POSTING_CONTEXT | false |
| KNOWN_CROSS_ORG_ACCOUNTING_LEAK | false (17B deep dive pending) |
| CRITICAL_ORPHAN_ROWS | 0 (production diagnostic) |

---

## Reconciliation Results

| Check | Result |
|-------|--------|
| AR_CONTROL_RECONCILIATION | PASS (demo org + integrity module) |
| AP_CONTROL_RECONCILIATION | PASS |
| PAYMENT_MODEL_INTEGRITY | PASS |
| CUSTOMER_DEPOSIT_ACCOUNTING | PASS — Dr Cash / Cr Deposits; application Dr Deposits / Cr AR |
| DEPOSIT_REVENUE_RECOGNITION_ON_RECEIPT | false |
| CUSTOMER_CREDIT_ACCOUNTING | PASS |
| VENDOR_CREDIT_ACCOUNTING | PASS |
| WRITEOFF_ACCOUNTING | PASS |
| REFUND_ACCOUNTING | PASS |
| REVERSAL_ACCOUNTING | PASS |
| INVENTORY_ACCOUNTING | PASS |
| GRNI_RECONCILIATION | PASS |
| PPV_ACCOUNTING | PASS |
| FIXED_ASSET_ACCOUNTING | PASS |
| PAYROLL_ACCOUNTING | PASS |
| SALES_TAX_ACCOUNTING | PASS |
| MO_REFERENCE_DATA | PASS |
| KS_REFERENCE_DATA | PASS |
| RECURRING_JOURNAL_INTEGRITY | PASS |
| ACCRUAL_ACCOUNTING | PASS |
| ACCRUAL_SETTLEMENT | PASS |
| INTERCOMPANY_INTEGRITY | PASS |
| INTERCOMPANY_PARTIAL_POSTING | false |
| INTERCOMPANY_RECONCILIATION | PASS |
| CONSOLIDATION_INTEGRITY | PASS |
| ELIMINATION_INTEGRITY | PASS |
| ELIMINATION_MUTATES_ENTITY_BOOKS | false |

---

## Financial Report Consistency

| Check | Result |
|-------|--------|
| TRIAL_BALANCE_INTEGRITY | PASS |
| PL_INTEGRITY | PASS |
| BALANCE_SHEET_INTEGRITY | PASS |
| BALANCE_SHEET_EQUATION | PASS (demo + unit tests) |
| CASH_FLOW_INTEGRITY | PASS |
| CASH_FLOW_RECONCILES_TO_CASH | PASS (known unsupported classes documented in report engine) |
| GL_REPORT_INTEGRITY | PASS |
| AR_AGING_INTEGRITY | PASS* — *two aging models exist; control vs dashboard (17A-002) |
| AP_AGING_INTEGRITY | PASS* |
| RETAINED_EARNINGS_INTEGRITY | PASS — derived; no duplicate closing journal |

---

## Job Costing

| Field | Value |
|-------|-------|
| JOB_ACCOUNTING_MODEL | ORG_SCOPED — jobs lack `legal_entity_id`; costs/revenue flow through entity-scoped journals |
| JOB_ENTITY_RISK | MEDIUM — mis-assigned job on cross-entity org could misallocate presentation; GL remains entity-correct via accounts |
| JOB_COSTING_INTEGRITY | PASS for single-entity orgs; KNOWN LIMITATION for multi-entity |

---

## Banking

| Check | Result |
|-------|--------|
| BANK_DUPLICATE_INGESTION_PROTECTION | PASS — external ID + dedup |
| BANK_MATCH_INTEGRITY | PASS |
| BANK_RECONCILIATION_INTEGRITY | PASS |
| BANK_TRANSFER_ACCOUNTING | PASS — entity guard in `transfer.ts` |

---

## Data Quality Results

Production read-only diagnostic (`scripts/verify-phase17a-production.mjs`):

- Full journal balance scan (all orgs, paginated)
- Null `legal_entity_id` counts on key tables
- Default entity cardinality per org
- HFAC snapshot verification
- Schema probes (047, 048, 049)

---

## Constraint Coverage

| Invariant | DB Enforced? | App Enforced? | Bypass Risk | Recommendation |
|-----------|--------------|---------------|-------------|----------------|
| Balanced journals | Yes (`teller_post_journal`) | Yes (`assertBalanced`) | Low | Keep canonical path only |
| One journal one entity | Yes (trigger 042) | Yes | Low | — |
| Account belongs to entity | Yes (RPC checks) | Yes (`validation.ts`) | Medium via service role | 17B RPC audit |
| Period close lock | Yes (`teller_books_closed_through`) | Yes | Medium — overload fixed in 048 | Monitor |
| Posted journal immutability | RLS (no UPDATE/DELETE) | N/A | Medium — INSERT re-enabled 047 | 17B tighten or SECURITY DEFINER only |
| Allocation ceiling | Partial (RPC) | Yes | Medium | 17C unique constraints |
| Idempotency keys | Partial (per domain) | Partial | Medium–High | 17C |
| Default entity uniqueness | App + partial DB | Yes | Low | Consider DB unique partial index |
| Cross-org references | RLS | Yes | Low–Medium | 17B |

---

## RLS Findings

**ACCOUNTING_RLS_AUDIT:** PASS with findings

- Migration 047 correctly scopes entity access on accounting tables.
- Journal tables: SELECT + INSERT only — **no UPDATE/DELETE policies** (good for immutability).
- **Finding:** INSERT policy re-enabled on journals — no current app path uses it, but future direct client insert would bypass `teller_post_journal` controls.
- Legacy zero-membership org access retained — document separately for 17B.
- Child-table policies generally match parent entity scope.

---

## Idempotency Findings

| Path | Key/Constraint | Safe Retry? |
|------|----------------|-------------|
| HFAC webhooks | Event ID + org mapping | Mostly yes |
| Bank imports | External transaction ID | Yes |
| Payments | Migration 007 keys | Partial |
| Journal posting | Source metadata | Partial |
| Inventory receipts | RPC guards | Partial |
| Intercompany | Pair idempotency | Yes |
| Settlement | Settlement keys | Yes |
| Recurring/accrual | Schedule + period guard | Partial |

**IDEMPOTENCY_COVERAGE_PERCENT:** ~70% (estimated)  
**HIGH_RISK_NON_IDEMPOTENT_PATHS:** payment allocation retries, some manual API POST without idempotency key

**Target phase:** 17C

---

## Concurrency Findings

| Area | Risk | Severity |
|------|------|----------|
| Payment allocation | Race on concurrent partial pays | MEDIUM |
| Deposit application | Concurrent apply | MEDIUM |
| Period close | Concurrent close attempts | LOW — RPC guards |
| Bank matching | Duplicate match attempt | LOW |
| Inventory/GRNI settle | Quantity races | MEDIUM |
| IC settlement | Partial settlement races | LOW |
| Document numbering | Unique constraint | LOW |

**Target phase:** 17C

---

## Audit Logging Findings

**AUDIT_LOG_COVERAGE:** PARTIAL

Present: settings changes, HFAC webhooks, some entity access, eliminations.  
Missing/high-value gaps: payment allocation detail, bank match/unmatch, credit application, intercompany reversal, period reopen (partial).

**Target phase:** 17E

---

## HFAC Integration

| Check | Result |
|-------|--------|
| HFAC_ACCOUNTING_INTEGRATION | PASS |
| HFAC_CLIENT_CONTROLLED_ENTITY | false — server resolves org + default entity |
| HFAC_MODIFIED_BY_17A | false |

HMAC via `verifyHfacWebhookAuth`; org resolution server-side; HFAC is integration source, not GL truth.

---

## Known Limitations

1. Jobs org-scoped — multi-entity job attribution is presentation-risk only.
2. Legacy zero-membership access for orgs without entity memberships.
3. `amount_paid` cache can drift — detected by `integrity.ts`, refreshed on post paths.
4. Two AR/AP aging models (control subledger vs `total − amount_paid`).
5. Cash flow statement: some transaction classes unsupported (documented in report engine).
6. Demo scripts contain intentional UNSAFE journal inserts — not production paths.

---

## Release Blockers

**PHASE17A_CRITICAL_BLOCKER:** false

No unbalanced production journals, cross-org leaks, period bypass, or material AR/AP control imbalance found.

---

## Findings Register

### 17A-001 — Presentation-layer payment truth duplication
- **AREA:** Payments / AR / AP
- **SEVERITY:** MEDIUM
- **DESCRIPTION:** `amount_paid` on documents is a denormalized cache; authoritative truth is allocation subledger then GL. Dashboard, intelligence, and some aging paths read cache.
- **EVIDENCE:** `src/lib/accounting/balances.ts`, `integrity.ts` stale-cache checks
- **RISK:** Report/dashboard divergence if cache refresh fails
- **REMEDIATION:** Single read path for open balances in UI; background cache reconciliation job
- **TARGET PHASE:** 17C / 17F

### 17A-002 — Dual AR/AP aging models
- **AREA:** Reporting
- **SEVERITY:** MEDIUM
- **DESCRIPTION:** Control subledger aging vs `total − amount_paid` aging coexist.
- **EVIDENCE:** `party-balances.ts`, report-engine aging
- **RISK:** User confusion; mismatched aging totals
- **REMEDIATION:** Unify aging source; label methods in UI
- **TARGET PHASE:** 17F / 17G

### 17A-003 — Journal INSERT RLS re-enabled
- **AREA:** GL / RLS
- **SEVERITY:** MEDIUM
- **DESCRIPTION:** Migration 047 allows INSERT on journal tables via RLS; no app uses it today.
- **EVIDENCE:** `047_phase16h_entity_controls.sql`
- **RISK:** Future client insert bypasses `teller_post_journal` balance/entity/period checks
- **REMEDIATION:** Remove INSERT policies; post only via SECURITY DEFINER RPCs
- **TARGET PHASE:** 17B

### 17A-004 — Jobs org-scoped (no entity column)
- **AREA:** Job costing
- **SEVERITY:** LOW
- **DESCRIPTION:** Jobs lack `legal_entity_id`; GL remains entity-safe via accounts.
- **EVIDENCE:** `docs/PHASE-16-ENTITY-SCOPE.md`
- **RISK:** Multi-entity job P&L attribution ambiguity
- **REMEDIATION:** Document; optional future entity column
- **TARGET PHASE:** 17F

### 17A-005 — Legacy zero-membership entity access
- **AREA:** Entity access / RLS
- **SEVERITY:** MEDIUM
- **DESCRIPTION:** Users without entity memberships may retain org-wide access per legacy behavior.
- **EVIDENCE:** Phase 16H docs, 047 RLS helpers
- **RISK:** Over-broad entity visibility
- **REMEDIATION:** Strict membership requirement with migration plan
- **TARGET PHASE:** 17B

### 17A-006 — Demo script UNSAFE journal paths
- **AREA:** Test fixtures
- **SEVERITY:** INFO
- **DESCRIPTION:** Controlled demo runners insert/delete journals directly for fixture setup.
- **EVIDENCE:** `scripts/controlled-phase9-demo-runner.ts` etc.
- **RISK:** None in production
- **REMEDIATION:** None required
- **TARGET PHASE:** —

### 17A-007 — Audit log gaps
- **AREA:** Audit / compliance
- **SEVERITY:** MEDIUM
- **DESCRIPTION:** High-value financial events partially logged.
- **EVIDENCE:** `src/lib/accounting/audit.ts` coverage map
- **RISK:** Weak forensic trail
- **REMEDIATION:** Expand audit events
- **TARGET PHASE:** 17E

### 17A-008 — Incomplete idempotency on retryable APIs
- **AREA:** Reliability
- **SEVERITY:** MEDIUM
- **DESCRIPTION:** Not all externally-triggerable paths have idempotency keys/constraints.
- **EVIDENCE:** Migration grep; API route review
- **RISK:** Duplicate payments/postings on retry
- **REMEDIATION:** Idempotency keys + unique constraints
- **TARGET PHASE:** 17C

### 17A-009 — Concurrency on payment/allocation paths
- **AREA:** Reliability
- **SEVERITY:** MEDIUM
- **DESCRIPTION:** Concurrent partial payments lack row-level serialization everywhere.
- **EVIDENCE:** Payment allocation RPC review
- **RISK:** Over-allocation under race
- **REMEDIATION:** Advisory locks or serializable transactions
- **TARGET PHASE:** 17C

### 17A-010 — COA control account deletion/deactivation
- **AREA:** Chart of accounts
- **SEVERITY:** LOW
- **DESCRIPTION:** System/control accounts rely on app guards; not all blocked at DB.
- **EVIDENCE:** COA API + account types
- **RISK:** Accidental deactivation of AR/AP/cash control accounts
- **REMEDIATION:** DB trigger prevent inactive/delete on system accounts
- **TARGET PHASE:** 17B / 17D

### 17A-011 — Accounting state version bumps
- **AREA:** Cache invalidation
- **SEVERITY:** LOW
- **DESCRIPTION:** Most post paths bump state version; verify elimination worksheet cache invalidation on all paths.
- **EVIDENCE:** `accounting-state` module usage grep
- **RISK:** Stale consolidated worksheet
- **REMEDIATION:** Audit all mutation paths
- **TARGET PHASE:** 17C

### 17A-015 — Stale controlled-test org payment debris
- **AREA:** Data quality / test fixtures
- **SEVERITY:** LOW
- **DESCRIPTION:** One isolated test org (`5a4f26ef-…`) holds 13 document-linked payments without journals from Sept 2026 acceptance runs. HFAC and registered demo orgs unaffected.
- **EVIDENCE:** Production read-only query; HFAC `linked_payments_missing_journal = 0`
- **RISK:** None for live customers; inflates global integrity counts
- **REMEDIATION:** `cleanup-controlled-test-orgs.mjs` extension in 17G
- **TARGET PHASE:** 17G

### 17A-014 — Demo org orphan payment rows
- **AREA:** Data quality / demo fixtures
- **SEVERITY:** LOW
- **DESCRIPTION:** Phase16 demo org contains payment rows without `document_id` or `journal_entry_id` from acceptance harness runs.
- **EVIDENCE:** 5 rows in `TELLER_PHASE16_DEMO_ORG_ID`; production check excludes HFAC
- **RISK:** None in production; confuses demo integrity scans
- **REMEDIATION:** Demo cleanup script in 17G
- **TARGET PHASE:** 17G

### 17A-013 — Posted journal line metadata UPDATE (fixed assets)
- **AREA:** Fixed assets / GL immutability
- **SEVERITY:** MEDIUM
- **DESCRIPTION:** `fixed-asset-acquisition.ts` UPDATEs `fixed_asset_id` on posted journal lines after linking.
- **EVIDENCE:** `src/lib/accounting/fixed-asset-acquisition.ts` lines 114–119
- **RISK:** Silent mutation of posted history metadata; bypasses canonical post path
- **REMEDIATION:** Tag at post time via RPC or use link table only
- **TARGET PHASE:** 17B / 17C

### 17A-012 — Performance observations (no action)
- **AREA:** Performance
- **SEVERITY:** INFO
- **DESCRIPTION:** Full journal scan paginates; large orgs may need indexed balance materialized views later.
- **EVIDENCE:** 17A production diagnostic runtime
- **RISK:** Report latency at scale
- **REMEDIATION:** Index review
- **TARGET PHASE:** 17D

---

## Recommended Phase 17 Work

| Phase | Focus |
|-------|-------|
| **17B** | RLS depth, journal INSERT removal, entity membership strict mode, COA control account DB guards |
| **17C** | Idempotency, concurrency locks, cache reconciliation, accounting state version completeness |
| **17D** | Index review, report query optimization |
| **17E** | Audit log expansion, backup/DR documentation |
| **17F** | Unified aging/balance presentation, job entity UX, accountant simplification |
| **17G** | Full E2E lifecycle release testing |
| **17H** | Final production baseline + launch readiness |

---

## Tooling Added (17A)

| Script | Purpose |
|--------|---------|
| `scripts/verify-phase17a-production.mjs` | Read-only production diagnostic |
| `scripts/run-verify-phase17a-production.mjs` | Gated runner (`TELLER_CONTROLLED_PROD_TEST=1`) |
| `scripts/controlled-phase17a-accounting-integrity.ts` | ~50 static + demo DB checks |
| `scripts/run-phase17a-accounting-diagnostic.mjs` | Orchestrator |
| `src/lib/accounting/phase17a.test.ts` | Static unit tests |

**MIGRATIONS_AUTO_APPLIED:** false  
**SQL_PATCHES_AUTO_APPLIED:** false  
**NEW_MIGRATION_REQUIRED:** false  
**NEW_SQL_PATCH_REQUIRED:** false

---

## Sign-off Criteria

- [x] Full diagnostic performed
- [x] Accounting truth map documented
- [x] Posting paths mapped
- [x] Production journals verified balanced (1664 checked, 0 unbalanced)
- [x] Key subledgers reconciled (demo + modules)
- [x] Data-quality checks complete
- [x] Findings assigned to 17B–17H (15 findings, 0 critical)
- [x] No critical blocker
- [x] HFAC unchanged (8 documents, 17 journals)
- [x] Production verify PASS (`verify:phase17a:production`)
- [x] Controlled acceptance 39/39 ×2 PASS
- [x] Tests/build PASS (`test:fast`, `test:phase` 17, `test:full`, `build`)

## Phase 17A Closeout

| Flag | Value |
|------|-------|
| PHASE_17A_STARTED | true |
| PHASE_17A_CODE_COMPLETE | true |
| PHASE_17A_DB_VERIFIED | true (read-only production diagnostic) |
| PHASE_17A_COMPLETE | true |
| PHASE17A_CRITICAL_BLOCKER | false |
| PHASE17A_FINDINGS_TOTAL | 15 |
| PHASE17A_CRITICAL_FINDINGS | 0 |
| PHASE17A_HIGH_FINDINGS | 0 |
| PHASE17A_MEDIUM_FINDINGS | 8 |
| PHASE17A_LOW_FINDINGS | 5 |
| PHASE17A_CONTROLLED_ACCEPTANCE | PASS |
| PHASE17A_ACCEPTANCE_SCENARIOS | 39 |
| PHASE17A_ACCEPTANCE_RERUN | PASS ×2 |
