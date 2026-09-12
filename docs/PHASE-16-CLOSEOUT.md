# Phase 16 — Multi-Entity Closeout

**Status:** Phase 16J final acceptance and release gate  
**Production project:** `ypixbxicdecwfafculha`  
**Production URL:** https://teller-indol.vercel.app

---

## Slice summary (16A–16J)

| Slice | Scope | Migration / patch |
|-------|-------|-------------------|
| **16A** | Legal entity foundation | 040 |
| **16B** | Entity access, switcher | 041 |
| **16C** | Entity books, COA, periods | 042, patch 043 |
| **16D** | Intercompany | 044, patch 044 provision |
| **16E** | Settlement + reconciliation | 045, patch 045 reconciliation |
| **16F** | Pre-elimination consolidated reporting | (app only) |
| **16G** | Consolidation eliminations | 046 |
| **16H** | Entity controls + RLS | 047 |
| **16I** | Multi-entity UX | (app only) |
| **16J** | Final acceptance + release | (app only) |

All migrations and patches listed above are **manually applied** in production. Cursor never auto-applies SQL.

---

## Accounting invariants

- **Organization ≠ legal entity** — tenant vs company books
- **One journal = one entity** — cross-entity single journals blocked
- **Documents, payments, bank accounts, periods** — entity-owned
- **Intercompany** — intentional cross-entity economic activity (paired journals)
- **Consolidation / eliminations** — read-only over entity books; eliminations do not mutate entity subledgers
- **HFAC** — server resolves default entity; client cannot choose arbitrary entity
- **Legacy zero-membership access** — retained for backward compatibility (Phase 17 review)

---

## Known limitations (deferred)

| Item | Classification |
|------|----------------|
| Legacy zero-membership → all entities | PHASE17 (security/product policy) |
| Phase 14 planning entity dimension | PHASE17 |
| Job `legal_entity_id` column (jobs org-scoped; GL entity-safe) | PRODUCT_BACKLOG |
| Multicurrency / FX / NCI / goodwill | FUTURE_ACCOUNTING |
| Multi-EIN payroll | NOT_REQUIRED V1 |
| Consolidated tax filing | FUTURE_ACCOUNTING |
| Intercompany inventory profit / FA transfer elimination | FUTURE_ACCOUNTING |
| Global search company disambiguation | PRODUCT_BACKLOG |
| Activity feed company labels | PRODUCT_BACKLOG |
| Full audit trail company column polish | PRODUCT_BACKLOG |

---

## Verification commands

```bash
# Static + unit
npm run verify:phase16j:production      # read-only prod probes
npm run verify:phase16i:multi-entity-ux
npm run verify:phase16h:entity-controls
TELLER_TEST_PHASE=16 npm run test:phase

# Controlled acceptance (demo org only — never HFAC)
TELLER_CONTROLLED_PROD_TEST=1 npm run accept:phase16j:controlled
TELLER_CONTROLLED_PROD_TEST=1 npm run accept:phase16j:controlled -- --rerun-2

# Release gates
npm run test:fast
npm run test:affected
npm run test:full
npm run build
```

---

## HFAC verification

- HFAC org is **never** used as a mutation fixture
- Before/after acceptance: compare document and journal counts
- Baseline counts may drift with legitimate production activity — compare pre/post within the same run

---

## Phase 16J release gate status (2026-09-12)

| Gate | Result |
|------|--------|
| Phase16J controlled acceptance | **46/46 ×2 PASS** |
| Production verify (read-only) | **PASS** |
| Unit tests | **935/935 PASS** |
| Production build | **PASS** |
| HFAC baseline | **8 docs / 17 journals unchanged** |
| `npm run test:full` | **FAIL** — legacy Phase 5 demo scripts omit `legal_entity_id` on document fixtures |

**Release patches (manual apply only):**

| Patch | Status | File |
|-------|--------|------|
| **048** | Applied | `supabase/patches/048_phase16j_books_closed_through_overload_fix.sql` |
| **049** | Applied | `supabase/patches/049_phase16j_legacy_posting_entity_fix.sql` |
| **050** | Applied | `supabase/patches/050_phase16j_payments_entity_default.sql` |

Demo runner fixes (in-repo): `forceOpenDemoBooks` O(1) reset, entity-scoped close fixtures, recurring template + close settings entity keys.

**Full release gate:** `npm run test:full` — **PASS** (unit 935+, build, demos 5–13, deploy audit).

---

## Rollback plan

**Application:** Promote or roll back Vercel deployment to the prior known-good commit if post-deploy smoke fails.

**Database:** Forward-only. Do **not** roll back manually applied migrations 040–047. If a schema defect is found, prepare a forward corrective migration/patch for manual review — do not auto-apply.

---

## 16J application changes

- Cross-company bank transfer guard (`assertSameEntityBankTransfer`)
- Transfer pair suggestions flag cross-entity pairs
- Banking panel shows active company label
- Final acceptance harness + production verify script
- This closeout document
