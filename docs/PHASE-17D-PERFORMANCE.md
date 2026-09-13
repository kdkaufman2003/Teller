# Phase 17D — Performance, Database Indexing & Scale Hardening

**Status:** Code complete · **Patch 053 requires manual application before production close**

---

## 1. Performance baseline

**PERFORMANCE_BASELINE = COMPLETE**

Production read-only inventory (2026-03-13):

| Table | Rows |
|-------|-----:|
| teller_audit_events | 12,306 |
| teller_journal_lines | 4,669 |
| teller_journal_entries | 1,664 |
| teller_documents | 1,197 |
| teller_document_lines | 1,123 |
| teller_accounts | 274 |
| teller_payments | 126 |
| teller_payment_allocations | 123 |
| teller_intercompany_transactions | 44 |
| teller_intercompany_settlements | 35 |
| teller_fixed_assets | 30 |
| teller_payroll_runs | 25 |
| teller_organizations | 24 |
| teller_legal_entities | 29 |

**LARGEST_TABLES:** audit_events, journal_lines, journal_entries, documents, document_lines

**FASTEST_GROWING_TABLES (projected):** journal_lines, audit_events, bank_transactions, documents

**SCALE_RISK_TABLES:** journal_lines (GL scans), documents (unbounded lists pre-17D), audit_events (retention → 17E)

Production journals: **1,664** checked, **0** unbalanced. HFAC unchanged (8 docs / 17 journals).

---

## 2. Target scale model

**TARGET_SCALE_MODEL = DOCUMENTED**

| Tier | Entities | Users | Journal lines | Documents | Bank txns |
|------|----------|-------|---------------|-----------|-----------|
| Small | 1 | 1–5 | 10k | 1k | 5k |
| Medium | 3–5 | 10–25 | 100k | 10k | 25k |
| Large | 10–25 | 50+ | 1M | 100k | 250k |
| Large consolidation | 20+ | 50+ | Multi-year GL | IC + eliminations | — |

Current production (~4.7k journal lines) is below Small tier — optimizations target **headroom**, not emergency firefighting.

---

## 3. Query inventory (summary)

| Surface | Pagination | Index support | N+1 risk | 17D action |
|---------|------------|---------------|----------|------------|
| Invoice list API | **Added** `.range()` | org+entity+kind (053) | Low | PASS |
| Bill list API | **Added** `.range()` | org+party+kind (053) | **Fixed** batch remaining | PASS |
| GL API | **Date-bounded DB page** | org+entity+date (existing) | Medium w/ search | PASS / partial |
| Bank transactions | Capped 200 | org+account+date | Low | PASS |
| AR/AP aging (report engine) | N/A (report) | AP aging partial index | Low (batched) | PASS |
| Bill/vendor list pages | SSR unbounded | 053 | **Fixed** batch in API | FINDINGS (SSR) |
| Job list P&L | Unbounded jobs | job_id line index | **Fixed** scoped lines | PASS |
| Consolidated P&L/BS/CF/TB | Per-entity GL load | entity date indexes | **Bounded parallel** | PASS |
| Dashboard | Partial limits | — | Low | FINDINGS |

---

## 4. Code changes (17D)

| Change | File(s) |
|--------|---------|
| List pagination standard | `src/lib/performance/pagination.ts` |
| Batch document remaining | `batchAuthoritativeDocumentRemaining()` in `balances.ts` |
| Bills/invoices API pagination | `api/bills/route.ts`, `api/invoices/route.ts` |
| AP dashboard batch | `ap-dashboard.ts` |
| GL date-bounded DB pagination | `api/ledger/route.ts` |
| Job P&L scoped journal lines | `job-profitability.ts` |
| Consolidated bounded parallel (4) | `entity-parallel.ts`, consolidated reports |
| Performance indexes | `supabase/patches/053_phase17d_performance_hardening.sql` |

---

## 5. Pagination standard

**PAGINATION_STANDARD = DOCUMENTED**

- Default page size: **100** (`DEFAULT_LIST_PAGE_SIZE`)
- Max page size: **500** (`MAX_LIST_PAGE_SIZE`)
- Offset/range pagination for document lists (Supabase `.range()`)
- GL: default **365-day** window + DB-level pagination when no search/account filter
- Bank: client `limit` capped at **200**

Cursor/keyset pagination deferred until offset limits prove insufficient.

---

## 6. Multi-entity parallelism

**MULTI_ENTITY_PARALLELISM_MODEL = bounded Promise pool (concurrency = 4)**

Consolidated reports load entity GL data with `mapConsolidatedEntities()` — avoids serial N× latency and uncontrolled full parallel blast.

**CONSOLIDATED_REPORT_QUERY_FANOUT = N entities × full GL through endDate (unchanged semantics; parallelized)**

---

## 7. Index patch 053 (manual apply)

**File:** `supabase/patches/053_phase17d_performance_hardening.sql`

Indexes (all `CREATE INDEX IF NOT EXISTS`):

1. `teller_journal_entries_reverses_entry_idx` — reversal lookups
2. `teller_documents_org_party_kind_date_idx` — vendor/customer lists
3. `teller_documents_org_entity_kind_date_idx` — entity document lists
4. `teller_documents_org_job_kind_idx` — job documents
5. `teller_payments_org_party_type_date_idx` — party payment history
6. `teller_payment_allocations_payment_id_idx` — allocation sums
7. `teller_bank_transactions_org_status_date_idx` — org-wide status queues
8. `teller_audit_events_org_resource_created_idx` — resource audit trail
9. `teller_schedule_occurrences_org_status_date_idx` — schedule date filters

Probe: `teller_phase17d_performance_probe()`

Static verify: `npm run verify:patch:053:static`

---

## 8. Performance budgets (engineering targets)

**PERFORMANCE_BUDGETS = DOCUMENTED**

| Surface | Target |
|---------|--------|
| Core list page (server) | < 500 ms typical |
| Standard financial report | < 2 s |
| Consolidated multi-entity | < 5 s (medium dataset) |
| Interactive search | < 500 ms |

Measured production timings not collected (low row counts); benchmarks are static/synthetic via `npm run benchmark:phase17d`.

---

## 9. Guards

| Guard | Result |
|-------|--------|
| PERFORMANCE_OPTIMIZATION_ACCOUNTING_DIFF | 0 (no semantic changes) |
| PERFORMANCE_OPTIMIZATION_SECURITY_REGRESSION | false |
| PERFORMANCE_OPTIMIZATION_RELIABILITY_REGRESSION | false |
| NEW_DUPLICATE_ACCOUNTING_TRUTH_SOURCE | false |
| UNSAFE_ACCOUNTING_CACHE_PATHS | 0 |
| UNBOUNDED_IN_MEMORY_ACCOUNTING_DATASETS | reduced (GL, lists) |
| GLOBAL_ACCOUNTING_TABLE_SCANS | 0 on default GL path |

Report equivalence: no aggregation logic changed — **TB/PL/BS/CF/AR/AP/Consolidation equivalence PASS by construction**.

---

## 10. Findings register

| ID | Severity | Summary | Status |
|----|----------|---------|--------|
| **17D-001** | HIGH | Invoice/bill list APIs unbounded | **Fixed** pagination |
| **17D-002** | HIGH | Per-row `authoritativeDocumentRemaining` N+1 on bills/AP | **Fixed** batch helper |
| **17D-003** | HIGH | Job list loaded all org journal entries per job | **Fixed** job-scoped lines |
| **17D-004** | HIGH | GL API loaded all entries then paginated in memory | **Fixed** date-bounded DB page |
| **17D-005** | MEDIUM | Consolidated reports serial per-entity GL load | **Fixed** bounded parallel |
| **17D-006** | MEDIUM | Missing compound indexes on hot paths | **Patch 053** prepared |
| **17D-007** | MEDIUM | SSR bill/invoice pages still unbounded | Documented — use API pagination |
| **17D-008** | MEDIUM | GL search/account filter still full-scan | Documented |
| **17D-009** | LOW | `teller_audit_events` largest table (12k) | Defer retention to 17E |
| **17D-010** | INFO | Redundant `teller_journal_entries` date indexes | No drop — manual review |

**PHASE17D_FINDINGS_TOTAL = 10** · CRITICAL = 0 · HIGH = 4 · MEDIUM = 4 · LOW = 1 · INFO = 1

---

## 11. Verification

```bash
npm run verify:patch:053:static
npm run benchmark:phase17d
TELLER_CONTROLLED_PROD_TEST=1 npm run verify:phase17d:production
TELLER_CONTROLLED_PROD_TEST=1 npm run accept:phase17d:controlled
TELLER_TEST_PHASE=17 npm run test:phase
npm run test:full
```

**Apply patch 053 manually before production close.**
