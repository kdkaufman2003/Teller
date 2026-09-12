# Phase 16 — Multi-Entity Implementation

## Roadmap

| Slice | Scope | Status |
|-------|-------|--------|
| **16A** | Legal entity foundation + data model | **Complete** (migration 040 manually applied 2026-09-11) |
| **16B** | Entity setup, switching, permissions | **Complete — migration 041 applied; 11/11 controlled acceptance (2026-09-11)** |
| **16C** | Entity-specific books, COA, periods | **Complete — 25/25 acceptance × 2 reruns (2026-09-11)** |
| **16D** | Intercompany + due-to/due-from | **Complete — migration 044 applied; 19/19 acceptance × 2** |
| **16E** | Intercompany settlement + reconciliation | **Complete — migration 045 + patch 045 applied; 28/28 acceptance × 2** |
| 16F–16J | Consolidation, UX, deploy | Not started |

Full architecture: [PHASE-16-ARCHITECTURE.md](./PHASE-16-ARCHITECTURE.md)

---

## Phase 16A (2026-09-11)

### Delivered (code)

| Area | Path |
|------|------|
| Migration (manual) | `supabase/migrations/040_phase16a_legal_entity_foundation.sql` |
| Types | `src/lib/accounting/legal-entity/types.ts` |
| Validation | `src/lib/accounting/legal-entity/validation.ts` |
| Resolver | `src/lib/accounting/legal-entity/resolver.ts` |
| Accounting context | `src/lib/accounting/legal-entity/context.ts` |
| Service | `src/lib/accounting/legal-entity/service.ts` |
| Unit tests | `src/lib/accounting/phase16a.test.ts` |
| Static verify | `scripts/verify-phase16-multi-entity.mjs` |
| Migration probe | `scripts/verify-migration-040-controlled.mjs` |
| Controlled acceptance | `scripts/controlled-phase16a-db-acceptance.ts` |
| Demo org setup | `scripts/setup-phase16-demo-org.mjs` |

### Migration 040 scope

- `teller_legal_entities` table + RLS
- Partial unique index: one active default per org
- `teller_seed_default_legal_entity(org_id)` RPC (idempotent)
- Backfill default entity for existing setup-completed orgs
- Extend `teller_complete_setup` to seed default entity on new orgs
- **Does not** add `legal_entity_id` to journals/documents/payments yet

### Operator commands

```bash
# After manual migration 040 apply:
npm run setup:phase16-demo-org
npm run verify:migration:040:controlled
npm run accept:phase16:controlled

# Development (no DB):
npm run verify:phase16:multi-entity
TELLER_TEST_PHASE=16 npm run test:phase
npm run test:fast
```

### 16A close gate (verified 2026-09-11)

Migration `040_phase16a_legal_entity_foundation.sql` **manually applied** to production (`ypixbxicdecwfafculha`).

| Check | Result |
|-------|--------|
| `MIGRATION_040_VERIFY` | PASS |
| `EXISTING_ORG_DEFAULT_ENTITY_BACKFILL` | PASS — 22 orgs backfilled at apply; 0 zero-default; 0 multi-default |
| `ONE_DEFAULT_LEGAL_ENTITY_PER_ORG` | PASS — partial unique index enforced (DB insert test) |
| `LEGAL_ENTITY_ORG_INTEGRITY` | PASS |
| `PHASE16A_RLS` | PASS — RLS enabled; 3 member-scoped policies; no DELETE policy |
| `DEFAULT_ENTITY_RESOLVER` | PASS |
| `ACCOUNTING_CONTEXT_VALIDATION` | PASS |
| `NEW_ORG_DEFAULT_ENTITY` | PASS — `teller_complete_setup` seeds default entity |
| `DEFAULT_ENTITY_SETUP_IDEMPOTENCY` | PASS |
| `PHASE16_CONTROLLED_ACCEPTANCE` | PASS — 11/11 |
| `MIGRATION_040_ECONOMIC_MUTATIONS` | 0 |
| `UNBALANCED_PRODUCTION_JOURNALS` | 0 (1487 entries) |
| `PHASE16A_JOURNALS_CREATED` | 0 |
| `HFAC_ECONOMIC_DATA_MODIFIED` | false (8 docs / 17 journals / 4 payments unchanged) |
| `HFAC_DEFAULT_ENTITY_COMPATIBILITY` | PASS — MAIN entity seeded; not an economic mutation |
| `PHASE15_TAX_REGRESSION` | PASS |
| `PHASE16_STATIC_VERIFY` | PASS |
| `FAST_TESTS` | PASS — 363/363 |
| `PHASE16_TESTS` | PASS — 10/10 |
| `AFFECTED_TESTS` | PASS — 421 unit + Phase 6/7/9/10/11.1/13 demos |
| `TARGETED_LINT` | PASS |
| `PLACEHOLDER_TESTS` | 0 |

**Backfill counts (at migration apply):** `ORGANIZATIONS_CHECKED=22`, `LEGAL_ENTITIES_CREATED=22`, `ORGS_WITH_ZERO_DEFAULT=0`, `ORGS_WITH_MULTIPLE_DEFAULTS=0`. Post-verification demo orgs add 2 controlled test tenants (not HFAC).

**Demo org:** `PHASE16_DEMO_ORG_ID=7eea46b5-a65d-4c85-94da-70b1d00a2036` (`Teller Phase 16 Demo`).

```
PHASE_16_STARTED = true
PHASE_16_SLICE = 16A

MIGRATION_040_MANUALLY_APPLIED = true
PHASE16_ARCHITECTURE_DOCUMENTED = true

PHASE_16A_CODE_COMPLETE = true
PHASE_16A_DB_VERIFIED = true
PHASE_16A_COMPLETE = true
PHASE_16_COMPLETE = false
PHASE_16B_STARTED = false

NEW_MIGRATION_REQUIRED = false
MANUAL_PATCH_REQUIRED = false
```

---

## Phase 16B pre-flight audit (2026-09-11)

### CURRENT_MEMBERSHIP_MODEL

- **Organization:** `teller_profiles.organization_id` — one org per user (V1).
- **Roles:** `owner | admin | bookkeeper | viewer` via `teller_profiles.role`.
- **Guards:** `requireBooks()`, `requireWriteBooks()`, `requireAdminBooks()` in `src/lib/api.ts`.
- **RLS:** `teller_is_org_member(org_id)` on all tenant tables.

### CURRENT_PERMISSION_MODEL

- Org RBAC only (no entity dimension before 16B).
- Write: `canWriteBooks(role)` → owner/admin/bookkeeper.
- Admin: owner/admin for settings, period reopen, entity access management.

### ENTITY_ACCESS_EXTENSION

**Chosen model: B + explicit rows (hybrid)**

| Role / state | Access |
|--------------|--------|
| owner, admin | All entities in org (canonical logic — no membership rows required) |
| bookkeeper, viewer with **zero** membership rows | All entities (backward compatible for existing single-entity customers) |
| Any role with **≥1** membership row | Only listed entities (restricted mode) |

Table: `teller_legal_entity_memberships` (migration 041).

New entities: owner/admin see immediately; restricted users do **not** gain access unless granted.

### ENTITY_SELECTION_MODEL

- **Active context:** `teller_profiles.active_legal_entity_id` (server-owned preference).
- **Resolution:** `resolveActiveLegalEntityContext()` → validates access on every request.
- **API guard:** `requireEntityBooks()` — never trusts client-supplied entity ID without reauthorization.
- **Single entity:** auto-resolved; no switcher noise (`showEntitySwitcher = false`).
- **Multi entity:** sidebar switcher lists authorized entities only.

### SESSION_CONTEXT_STRATEGY

- `getSessionContext()` extended with `activeLegalEntity`, `accessibleLegalEntities`, `showEntitySwitcher`.
- **URL strategy (V1):** stable routes; active entity in session/profile — not route params (avoids route churn before 16C domain scoping).
- **Persistence:** profile column + revalidation; not localStorage alone.
- `PERSISTED_ENTITY_ID_IS_TRUSTED_WITHOUT_RECHECK = false`

### HFAC_DEFAULT_CHANGE_STRATEGY

- HFAC webhooks resolve org → **default legal entity** (unchanged).
- **Block** default entity changes while `teller_integrations.provider = 'hfac'` is enabled (`teller_set_default_legal_entity` RPC + app guard).
- No HFAC code changes in 16B.
- Future: explicit integration → entity mapping table (16C+).

### Phase 16B delivered (code)

| Area | Path |
|------|------|
| Migration (manual) | `supabase/migrations/041_phase16b_entity_access.sql` |
| Entity access | `src/lib/accounting/legal-entity/access.ts` |
| Active context | `src/lib/accounting/legal-entity/active-context.ts` |
| API guard | `requireEntityBooks()` in `src/lib/api.ts` |
| Session | `src/lib/session.ts` |
| REST API | `src/app/api/legal-entities/**` |
| Settings UI | `/app/settings/entities` |
| Switcher | `src/components/legal-entity/EntitySwitcher.tsx` |
| Unit tests | `src/lib/accounting/phase16b.test.ts` |
| Migration probe | `scripts/verify-migration-041-controlled.mjs` |
| Controlled acceptance | `scripts/controlled-phase16b-db-acceptance.ts` |

### Operator commands

```bash
# After manual migration 041 apply:
npm run setup:phase16-demo-org   # creates controlled profile fixture (idempotent)
npm run verify:migration:041:controlled
npm run accept:phase16b:controlled

# Development (no DB writes):
npm run verify:phase16:multi-entity
TELLER_TEST_PHASE=16 npm run test:phase
npm run test:fast
```

### 16B verification (2026-09-11)

Production ref `ypixbxicdecwfafculha` after manual migration 041 apply:

| Object | Status |
|--------|--------|
| `teller_legal_entity_memberships` | OK |
| `teller_profiles.active_legal_entity_id` | OK |
| `teller_can_access_legal_entity()` | OK |
| `teller_set_default_legal_entity()` | OK |
| Economic baseline | 0 unbalanced production journals; HFAC 8 docs / 17 journals / 4 payments / 4 allocations / 0 tax unchanged |

### 16B acceptance harness repair (2026-09-11)

Initial controlled acceptance: **6/10** — four scenarios failed with `demo org has no profile`.

**Root cause:** `setup-phase16-demo-org` seeded org + legal entities but never created the isolated `teller_profiles` row required for restricted-access tests. Not an authorization defect.

**Fix (harness only — no accounting semantic changes, no schema change):**

- `scripts/phase16-controlled-fixture.mjs` — deterministic controlled auth user + bookkeeper profile (`TELLER_PHASE16_RESTRICTED_PROFILE_ID`)
- `scripts/setup-phase16-demo-org.mjs` — creates/resets controlled profile on setup
- `scripts/controlled-phase16b-db-acceptance.ts` — idempotent entity/membership state; uses explicit `MAIN` vs `BR16B` entity codes (not default resolver) so prior default changes do not alias restriction tests; adds zero-membership backward-compat assertion

**Final acceptance:** **11/11** × 3 consecutive idempotent reruns.

### 16B close gate

```
PHASE_16_SLICE = 16B
PHASE_16B_STARTED = true
PHASE_16B_CODE_COMPLETE = true
PHASE_16B_DB_VERIFIED = true
PHASE_16B_COMPLETE = true

MIGRATION_041_VERIFY = PASS
NEW_MIGRATION_REQUIRED = false
MANUAL_PATCH_REQUIRED = false
```

### Controlled acceptance scenarios (16B — 11)

1. Owner sees all entities  
2. Second legal entity (idempotent)  
3. Zero membership backward compatibility  
4. Grant restricted access to one entity (`MAIN`)  
5. Same-org unauthorized entity denied (`BR16B`)  
6. Cross-org entity denied  
7. Active context resolves (`resolveActiveLegalEntityContext`)  
8. Revoke access takes effect  
9. Default change preserves history (0 journals)  
10. Entity admin creates zero journals  
11. HFAC default handling safe  

---

## Phase 16C preflight (2026-09-11)

### Ownership matrix (16C scope)

| Domain / table | Current owner | Target owner | Change in 16C? | Backfill | Risk |
|----------------|---------------|--------------|----------------|----------|------|
| `teller_accounts` | org | **legal entity** | Yes | default entity | Medium — unique constraint migration |
| `teller_journal_entries` | org | **legal entity** | Yes | default entity | High — posting RPC signature change |
| `teller_journal_lines` | via entry | inherit journal | No column | — | Low |
| `teller_documents` | org | **legal entity** | Yes | default entity | Medium — posting coupling |
| `teller_payments` | org | **legal entity** | Yes | default entity | Medium |
| `teller_bank_connections` | org | org (provider auth) | No | — | Low |
| `teller_bank_accounts` | org | **legal entity** | Yes | default entity | Medium |
| `teller_period_closes` + close aux | org | **legal entity** | Yes | default entity | High — independent close per entity |
| `teller_close_settings` | org PK | **org + entity PK** | Yes | default entity | Medium |
| `teller_accounting_state_versions` | org PK | **org + entity PK** | Yes | default entity | Medium |
| `teller_entity_accounting_settings` | — | **new** | Yes | seed rows | Low |
| `teller_ap_settings` | org PK | entity (16C app) | Deferred app | default entity | Low — app layer in follow-up |
| `teller_tax_settings` | org PK | entity (later) | Partial | reference packs stay global | Medium — Phase15 intact |
| `teller_inventory_account_mappings` | org | entity (16C2) | Deferred | — | Low |
| `teller_payroll_account_mappings` | org | entity (16C2) | Deferred | — | Low |
| `teller_fixed_asset_settings` | org | entity (16C2) | Deferred | — | Low |
| `teller_jobs` | org | entity (16D+) | No | — | Low |
| `teller_parties` | org (shared) | org (shared) | No | — | Low |

Production snapshot (`snapshot:phase16c:controlled`): 1487 journals, 156 accounts, 26 legal entities, 0 unbalanced, HFAC 8/17 unchanged.

### Migration 042 (prepared — manual apply)

Path: `supabase/migrations/042_phase16c_entity_books.sql`

Static verify: `npm run verify:migration:042:static`

**Not in 042 (application follow-up after apply):** thread `AccountingContext` through `post.ts` and domain APIs; entity-scoped `loadOrgAccounts`; AP/tax/inventory/payroll settings split; new-entity COA clone UX; HFAC resolver uses default entity; journal idempotency indexes extended with `legal_entity_id`.

**Migration 042:** manually applied 2026-09-11 — `MIGRATION_042_VERIFY = PASS`.

**Application wiring (16C):**

- `requireAccountingBooks` / `requireEntityBooks` on ledger, trial balance, periods, banking, GL, reports, tax settings
- Entity-scoped `buildTrialBalance`, `evaluateCloseReadiness`, `loadAccountingStateVersions`
- `entity-books/`: COA setup (`initializeEntityCoa`), entity settings (`teller_entity_accounting_settings`), cross-entity validation
- APIs: `/api/legal-entities/[id]/coa/setup`, `/api/accounting/entity-settings`
- Payment allocation cross-entity guard in `recordPaymentAllocation`
- Controlled acceptance: `scripts/controlled-phase16c-db-acceptance.ts` (25 scenarios)

### Patch 043 — accounting state entity isolation (manual apply)

Path: `supabase/patches/043_phase16c_accounting_state_entity.sql`

**Why required:** Migration 042 moved `teller_accounting_state_versions` from organization-level identity to `(organization_id, legal_entity_id)`. Legacy Phase 9 RPCs still bumped versions with `ON CONFLICT (organization_id)`, which no longer matches the PK. Symptom: `postJournal` failed with an ON CONFLICT constraint error.

**What 043 fixes (entity isolation only — not accounting semantics):**

| Component | Change |
|-----------|--------|
| `teller_get_accounting_state` | Optional `p_legal_entity_id`; reads entity row |
| `teller_increment_accounting_version` | Conflicts on `(organization_id, legal_entity_id)` |
| `teller_increment_close_state_version` | Same |
| `teller_journal_entries_bump_accounting_version` trigger | Passes `NEW.legal_entity_id` |
| Checklist/reconciliation bump triggers | Entity-scoped close-state bumps |

Static verify: `npm run verify:migration:043:static`

**Applied:** 2026-09-11 (production `ypixbxicdecwfafculha`, manual operator apply)

### 16C close gate (verified 2026-09-11)

| Check | Result |
|-------|--------|
| `MIGRATION_042_VERIFY` | PASS |
| `PATCH_043_APPLIED` | PASS (manual) |
| `PHASE16C_CONTROLLED_ACCEPTANCE` | PASS — 25/25 |
| Idempotent rerun ×2 | PASS |
| `UNBALANCED_PRODUCTION_JOURNALS` | 0 |
| `HFAC_ECONOMIC_DATA_MODIFIED` | false |
| `PHASE16_STATIC_VERIFY` | PASS |
| `FAST_TESTS` | PASS — 373/373 |
| `PHASE16_TESTS` | PASS — 31/31 |
| `PHASE_16D_STARTED` | true (code); DB pending 044 |

**Delivered in 16C:**

- Entity-scoped COA, journals, documents, payments, bank accounts, periods
- Entity-scoped ledger, trial balance, close readiness, period close/reopen
- Entity accounting settings (`teller_entity_accounting_settings`) for AP/tax/inventory GL refs
- New-entity COA setup (standard template or copy structure — no balances/history)
- Cross-entity posting, allocation, and default-account guards
- Single-entity backward compatibility via default entity resolver
- HFAC continues org → default entity (no client-controlled entity)

**Operator commands:**

```bash
npm run accept:phase16c:controlled   # run twice for idempotency
npm run verify:phase16:multi-entity
npm run verify:migration:043:static
TELLER_TEST_PHASE=16 npm run test:phase
```

---

## Phase 16D (2026-09-12)

### Delivered (code — DB pending migration 044)

| Area | Path |
|------|------|
| Migration (manual) | `supabase/migrations/044_phase16d_intercompany.sql` |
| Types + validation | `src/lib/accounting/intercompany/` |
| Posting primitive | `postIntercompanyTransaction`, typed helpers |
| Reversal | `reverseIntercompanyTransaction` → atomic RPC |
| Reconciliation | `getIntercompanyPairBalance`, pair balance RPC |
| API | `/api/accounting/intercompany`, `[id]`, `[id]/reverse`, `reconciliation` |
| UI | `/app/accounting/intercompany` |
| Unit tests | `src/lib/accounting/phase16d.test.ts` |
| Static verify | `npm run verify:phase16d:intercompany`, `verify:migration:044:static` |
| Controlled acceptance | `scripts/controlled-phase16d-db-acceptance.ts` (25 scenarios) |

### Migration 044 scope

- `teller_intercompany_transactions` — group linking paired journals
- `teller_intercompany_account_pairs` — per-entity due-to/due-from GL mapping
- `teller_provision_intercompany_accounts` — idempotent account setup
- `teller_atomic_post_intercompany` — atomic paired posting + idempotency
- `teller_atomic_reverse_intercompany` — atomic paired reversal
- `teller_intercompany_pair_balances` — reconciliation (no auto-fix)
- RLS: org + entity access; writes via RPC only
- Immutability trigger on posted groups

### Operator commands (after manual migration 044 apply)

```bash
npm run verify:migration:044:static
npm run verify:phase16d:intercompany
npm run accept:phase16d:controlled   # run twice for idempotency
TELLER_TEST_PHASE=16 npm run test:phase
```

### Patch 044 — provision pair lookup fix

Migration 044 `teller_provision_intercompany_accounts` used `SELECT … INTO rowtype` with a partial column list, returning null account IDs when a pair row already existed. App layer falls back to `teller_intercompany_account_pairs` until patch is applied.

**Patch:** `supabase/patches/044_phase16d_provision_pair_lookup_fix.sql` (manually applied 2026-09-12)

### 16D close gate (verified 2026-09-12)

| Check | Result |
|-------|--------|
| `MIGRATION_044_VERIFY` | PASS (production probe) |
| `MIGRATION_044_STATIC_VERIFY` | PASS |
| `PHASE16D_CONTROLLED_ACCEPTANCE` | PASS — 19/19 |
| Idempotent rerun ×2 | PASS |
| `INTERCOMPANY_PARTIAL_POSTING_POSSIBLE` | false (16D_12 atomic rollback) |
| `INTERCOMPANY_BOTH_PERIODS_OPEN` | PASS (16D_11 dual-period deny) |
| `UNBALANCED_PRODUCTION_JOURNALS` | 0 |
| `HFAC_ECONOMIC_DATA_MODIFIED` | false (17 journals) |
| `PHASE16D_CODE_COMPLETE` | true |
| `PHASE_16D_DB_VERIFIED` | true |
| `PHASE_16D_COMPLETE` | true |
| `PHASE_16E_STARTED` | true |
| `PHASE_16E_COMPLETE` | true |
| `CONSOLIDATION_ELIMINATIONS_IN_16D` | false |

**Operator commands:**

```bash
npm run verify:migration:044:static
npm run verify:migration:044:controlled
npm run accept:phase16d:controlled   # run twice
TELLER_TEST_PHASE=16 npm run test:phase
```

---

## Phase 16E (2026-09-12)

### Delivered (code + DB verified 2026-09-12)

| Area | Path |
|------|------|
| Migration (manual) | `supabase/migrations/045_phase16e_intercompany_settlement.sql` |
| Settlement module | `src/lib/accounting/intercompany/settlement/` |
| Posting | `postIntercompanySettlement` → `teller_atomic_post_intercompany_settlement` |
| Reversal | `reverseIntercompanySettlement` → atomic RPC |
| Open items | `listIntercompanyOpenItems`, `getIntercompanyTransactionOpenBalance` |
| Reconciliation report | `getIntercompanyPairReconciliation` (as-of, gross/net, status) |
| Auto-apply | `autoApplySettlementAllocations` (oldest-first, pre-post review) |
| API | `/api/accounting/intercompany/settlements`, `[id]/reverse`, `open-items` |
| UI | Extended `/app/accounting/intercompany` — Transactions / Settlements / Reconciliation tabs |
| Unit tests | `src/lib/accounting/phase16e.test.ts` |
| Static verify | `npm run verify:phase16e:settlement`, `verify:migration:045:static` |
| Controlled acceptance | `scripts/controlled-phase16e-db-acceptance.ts` (30 scenarios) |

### Migration 045 scope

- `teller_intercompany_settlements` — settlement record + paired journal links
- `teller_intercompany_settlement_allocations` — allocation truth for open balances
- `teller_intercompany_tx_open_balance` / `teller_intercompany_tx_settled_amount`
- `teller_intercompany_open_items` — open item list (as-of aware)
- `teller_intercompany_pair_reconciliation` — accountant reconciliation report
- `teller_resolve_entity_cash_account` — server-side cash GL resolution
- `teller_atomic_post_intercompany_settlement` / `teller_atomic_reverse_intercompany_settlement`
- Bank match resource type `intercompany_settlement` (foundation — no auto-match in 16E)
- RLS: org + entity access; writes via RPC only; posted immutability

### Operator commands (after manual migration 045 apply)

```bash
npm run verify:migration:045:static
npm run verify:phase16e:settlement
npm run accept:phase16e:controlled   # run twice for idempotency
TELLER_TEST_PHASE=16 npm run test:phase
```

### Patch 045 — reconciliation RPC + reversed settlement immutability

Migration 045 `teller_intercompany_pair_reconciliation` had invalid table aliases in `last_activity`. Patch `supabase/patches/045_phase16e_reconciliation_immutable_fix.sql` applied manually 2026-09-12.

### 16E close gate (verified 2026-09-12)

| Check | Result |
|-------|--------|
| `MIGRATION_045_STATIC_VERIFY` | PASS |
| `MIGRATION_045_CONTROLLED_VERIFY` | PASS |
| `PHASE16E_SETTLEMENT_VERIFY` | PASS |
| `PHASE16E_CONTROLLED_ACCEPTANCE` | PASS — 28/28 |
| Idempotent rerun ×2 | PASS |
| `SETTLEMENT_PARTIAL_POSTING_POSSIBLE` | false (16E_16) |
| `SETTLEMENT_BOTH_PERIODS_OPEN` | PASS (16E_15) |
| `HFAC_ECONOMIC_DATA_MODIFIED` | false |
| `PHASE_16E_CODE_COMPLETE` | true |
| `PHASE_16E_DB_VERIFIED` | true |
| `PHASE_16E_COMPLETE` | true |
| `PHASE_16F_STARTED` | true |
| `PHASE_16F_CODE_COMPLETE` | true |
| `PHASE_16F_DB_VERIFIED` | true |
| `PHASE_16F_COMPLETE` | true |

---

## Phase 16F — consolidated pre-elimination reporting

**Purpose:** Query/reporting layer combining selected legal entities within one organization. Does **not** post journals, rewrite entity books, or eliminate intercompany balances (Phase 16G).

### Scope model

- API / page params: `entityIds`, `includeAll=1`, `periodStart`, `periodEnd`, `asOf`
- Server resolves scope via `resolveConsolidationScope` — **never trust client org IDs**
- User must have access to **every** selected entity (`assertEntityAccess` per entity)
- `All Companies` is explicit (`includeAllEntities`) — single-entity reports unchanged at `/app/reports`

### Account grouping

- Key: `${type}|${subtype}|${code}|${normalizedName}` — avoids merging unrelated accounts that share type/subtype/code but differ semantically by label
- No explicit mapping overrides in 16F (`ACCOUNT_MAPPING_OVERRIDE_NEEDED = false`)
- Named consolidation groups deferred (`NAMED_CONSOLIDATION_GROUPS_IN_16F = false`)

### Reports

| Report | Builder | Route |
|--------|---------|-------|
| Trial balance | `buildConsolidatedTrialBalance` | `/api/reports/consolidated/trial-balance` |
| P&L | `buildConsolidatedProfitAndLoss` | `/api/reports/consolidated/profit-loss` |
| Balance sheet | `buildConsolidatedBalanceSheet` | `/api/reports/consolidated/balance-sheet` |
| Cash flow | `buildConsolidatedCashFlow` | `/api/reports/consolidated/cash-flow` |

UI: `/app/reports/consolidated` — pre-elimination banner, intercompany warnings, per-entity period status, entity contribution drill-down.

### Invariants

- `CONSOLIDATION_REWRITES_ENTITY_BOOKS = false`
- `CONSOLIDATION_POSTS_JOURNALS = false`
- `ELIMINATION_ENTRIES_IN_16F = false`
- Intercompany due-to/due-from remain visible pre-elimination
- Settlement reduces GL balances only — not treated as elimination
- Single currency (USD); no FX translation

### Operator commands (no migration 046)

```bash
npm run verify:phase16f:consolidated-reporting
npm run accept:phase16f:controlled   # run twice for idempotency; report-only, 0 journal side effects
TELLER_TEST_PHASE=16 npm run test:phase
```

### 16F close gate (verified 2026-09-12)

| Check | Result |
|-------|--------|
| `PHASE16F_CONSOLIDATED_REPORTING_VERIFY` | PASS |
| `PHASE16F_CONTROLLED_ACCEPTANCE` | PASS — 27/27 |
| Idempotent rerun ×2 | PASS |
| `UNRELATED_SAME_CODE_ACCOUNT_MERGE` | false (16F_01) |
| `EQUIVALENT_CROSS_ENTITY_ACCOUNT_GROUPING` | PASS (16F_02) |
| `CONSOLIDATION_REPORT_SIDE_EFFECTS` | false (16F_24) |
| `HFAC_MODIFIED` | false |
| `UNBALANCED_PRODUCTION_JOURNALS` | 0 |
| `NEW_MIGRATION_046_REQUIRED` | false |
| `PHASE_16F_CODE_COMPLETE` | true |
| `PHASE_16F_DB_VERIFIED` | true |
| `PHASE_16F_COMPLETE` | true |

---

## Table inventory (organization_id audit)

**100 org-scoped tables** across: core tenant (16), accounting (29), master data (4), banking (9), inventory/FA/payroll (22), planning (6), tax (14).

**11 without organization_id:** org root, child lines, bank connection secrets, global tax reference (6).

See [PHASE-16-ARCHITECTURE.md](./PHASE-16-ARCHITECTURE.md) for entity-scope classification.
