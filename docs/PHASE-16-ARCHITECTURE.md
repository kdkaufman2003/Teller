# Phase 16 — Multi-Entity Architecture

**Slice 16A:** Legal entity foundation (tenant vs books separation)  
**Status:** 16A/16B/16C complete — entity-scoped books live (migrations 040–042 + patch 043). **16D complete** — migration 044 + patch 044 provision fix applied. **16E complete** — migration 045 + patch 045 reconciliation fix applied.

## Canonical terminology

| Term | Meaning |
|------|---------|
| **Organization** | Teller tenant/workspace — subscription boundary, membership, top-level RLS |
| **Legal entity** | Accounting company whose books belong to one organization |

```
Organization (tenant)
├── Legal Entity A → independent books
├── Legal Entity B → independent books
└── Legal Entity C → independent books
        ↓ (future 16F–16G)
Consolidated reporting (elimination layer — does not rewrite entity books)
```

**Do not rename `organization_id`.** Tenant isolation remains org-scoped.

---

## CURRENT_ORGANIZATION_MODEL

Today, **one organization = one set of books**:

- `teller_profiles.organization_id` — single org per user (V1)
- `requireBooks()` → `{ organizationId }` — no entity dimension
- `teller_is_org_member(organization_id)` — all RLS policies
- Economic tables (~100) keyed directly on `organization_id`
- HFAC webhooks resolve → `organizationId` → all writes

Closest precursors (not legal entities):

- `teller_organizations.legal_name` — display/legal name of the tenant
- `teller_locations` — branch/location stub (org-scoped)
- `teller_inventory_locations` — warehouse sites (org-scoped)

---

## TABLES_USING_ORGANIZATION_ID

**100 tables** carry `organization_id` directly. **11 tables** inherit org via parent join (`teller_document_lines`, `teller_journal_lines`, etc.) or are global reference data.

See Phase 16A audit categories in [PHASE-16-IMPLEMENTATION.md](./PHASE-16-IMPLEMENTATION.md).

---

## TABLES_REQUIRING_LEGAL_ENTITY_ID

Future slices will add `legal_entity_id` to **entity-scoped economic data**:

| Domain | Tables (representative) |
|--------|-------------------------|
| GL / journals | `teller_journal_entries`, `teller_adjusting_journal_entries`, recurring journal templates/runs |
| Documents | `teller_documents`, sequences, allocations, write-offs |
| Payments | `teller_payments`, `teller_payment_allocations` |
| Banking | `teller_bank_accounts`, transactions, matches, reconciliations |
| AP/PO | `teller_purchase_orders`, receipts, recurring bills |
| COA | `teller_accounts` (see COA recommendation below) |
| Periods | `teller_period_closes`, close reviews, checklist |
| Jobs | `teller_jobs`, job budgets (accounting ownership) |
| Inventory | items, locations, balances, movements, counts |
| Fixed assets | assets, depreciation batches/entries |
| Payroll | runs, components, labor entries, settlements |
| Tax (Phase 15) | `teller_tax_settings`, registrations, transactions, filing periods, authority payments |
| Planning | budgets, forecasts, versions, lines |

**Child lines** (`teller_journal_lines`, `teller_document_lines`) inherit entity from header — no separate `legal_entity_id` on lines.

---

## TABLES_THAT_SHOULD_REMAIN_ORG_SCOPED

| Domain | Tables / concepts |
|--------|-------------------|
| Tenant root | `teller_organizations` |
| Membership | `teller_profiles` (16B: add entity memberships) |
| Integrations | `teller_integrations`, webhook events, bank **connections** (provider tokens) |
| Shared master | `teller_parties` (customers/vendors) — org directory |
| Industry / labels | `teller_industry_settings` |
| Automation (org policy) | `teller_org_automation_settings`, scheduler runs |
| Audit | `teller_audit_events` |
| Global tax reference | `teller_tax_jurisdictions`, rates, rule sets (no org) |
| Intelligence | `teller_intelligence_suggestions` |

---

## AMBIGUOUS_TABLES

| Table | Recommendation |
|-------|----------------|
| `teller_accounts` | **Entity-specific account instances** (Option A) — each entity owns COA rows; org may share template at setup. Independent trial balance requires entity-owned accounts. |
| `teller_ap_settings` / `teller_close_settings` | Move to **entity scope** in 16C (approval thresholds, close policy per entity) |
| `teller_tax_settings` | **Entity scope** — registrations and liability belong to filing entity |
| `teller_planning_settings` | Org default + entity overrides in 16C+ |
| `teller_locations` | Remain org-scoped operational sites; not legal entities |
| `teller_jobs` | Entity-scoped accounting ownership; shared operational view optional later |

---

## COA recommendation (16A decision)

**Option A — entity-specific account instances** (recommended):

- Each legal entity has its own `teller_accounts` rows (`organization_id` + `legal_entity_id`)
- Trial balance = sum journals for one `legal_entity_id`
- Intercompany due-to/due-from accounts are entity-specific (16D)

Option B (org template + mapping) deferred — adds indirection without clear V1 benefit.

---

## SHARED_PARTY_MODEL

```
Organization → teller_parties (shared directory)
Legal Entity → documents/payments/journals referencing party_id
```

**Invariant:** `SHARED_PARTY_DOES_NOT_SHARE_AR_AP_BALANCES = true`

Balances live on entity-scoped documents and allocations, not on the party row.

---

## Journal architecture

Every journal belongs to **exactly one** legal entity:

- `CROSS_ENTITY_SINGLE_JOURNAL_ALLOWED = false`
- Intercompany (16D): paired journals in Entity A and Entity B, linked by `intercompany_transaction_id`

Journal lines inherit entity from header — no cross-entity lines within one entry.

---

## Payment, banking, inventory, assets, payroll, tax, jobs

| Rule | Value |
|------|-------|
| `DOCUMENT_SINGLE_LEGAL_ENTITY` | true |
| `CROSS_ENTITY_DIRECT_PAYMENT_ALLOCATION` | false |
| `BANK_ACCOUNT_SINGLE_LEGAL_ENTITY` | true (provider connection may stay org-scoped) |
| Inventory / FA / payroll | entity-scoped |
| Tax registrations & filings | entity-scoped |
| Jobs | one entity owns job accounting |

---

## INTEGRATION_IMPACT

**HFAC (unchanged in 16A):**

```
HFAC webhook → organizationId (mapped) → default legal entity (implicit)
```

- `HFAC_DEFAULT_ENTITY_COMPATIBILITY = PASS`
- No HFAC repo changes
- Future: `legal_entity_external_id` mapping before client-supplied entity IDs

**Resolution priority (future):**

1. Explicit trusted external entity ID
2. Integration mapping table
3. Organization default legal entity

`CLIENT_CONTROLLED_LEGAL_ENTITY = false`

---

## REPORTING_IMPACT

### Phase 16F (pre-elimination consolidation)

```
Entity A TB + Entity B TB = Consolidated TB (pre-elimination)
```

- Reporting-only: aggregate per-entity `buildTrialBalance`, `buildProfitAndLoss`, `buildBalanceSheet`, `buildCashFlowStatement`
- Account grouping key: `type|subtype|code|normalizedName` (never database account IDs)
- Scope: `resolveConsolidationScope` with server-side entity authorization
- Intercompany due-to/due-from **visible**; pair reconciliation warnings when out of balance
- No migration 046 — scope via API params; named groups deferred

### Phase 16G (future eliminations)

```
Consolidated TB (pre-elimination) + elimination adjustments = Consolidated TB (eliminated)
```

`CONSOLIDATION_REWRITES_ENTITY_BOOKS = false` — eliminations remain reporting-layer only.

---

## SECURITY / RLS strategy

1. **Organization isolation first** — existing `teller_is_org_member(organization_id)`
2. **Entity authorization second** — Phase 16B: `teller_legal_entity_memberships`
3. `CROSS_ORG_ENTITY_ACCESS = false`
4. Never replace org checks with entity-only checks

Phase 16A RLS on `teller_legal_entities`: org member read; writers insert/update; no DELETE (archive via `is_active`).

---

## MIGRATION_STRATEGY (staged)

| Stage | Slice | Action |
|-------|-------|--------|
| 1 | **16A** | `teller_legal_entities`, default entity, backfill, setup RPC |
| 2 | 16B | Entity memberships, switching |
| 3 | 16C | Entity-scoped COA, periods, settings |
| 4 | 16D–16E | Intercompany + settlement |
| 5 | 16F–16G | Consolidation + eliminations |
| Per domain | 16C+ | Add nullable `legal_entity_id`, backfill to default, validate, constrain |

**Nullability:** avoid NOT NULL on all economic tables in one migration.

**Backfill validation:**

- Every setup-completed org has exactly one default entity
- No cross-org entity references
- Journal/document counts and amounts unchanged (ownership metadata only)

`MULTI_ENTITY_BACKFILL_CHANGES_ACCOUNTING_AMOUNTS = false`

---

## BACKWARD_COMPATIBILITY_STRATEGY

Existing orgs receive one default legal entity (`entity_code = MAIN`) named from org `name` / `legal_name`.

```
BEFORE: Organization → books
AFTER:  Organization → Default Legal Entity → same books (until domain migration)
```

`SINGLE_ENTITY_BACKWARD_COMPATIBILITY = PASS`

Resolver: `resolveDefaultLegalEntity()` / `resolveAuthorizedLegalEntity()` — canonical server-side; no scattered `is_default` queries.

`AccountingContext { organizationId, legalEntityId }` — pattern for future posting services (16A interface only).

---

## Entity lifecycle rules

| Rule | Value |
|------|-------|
| `LEGAL_ENTITY_WITH_HISTORY_HARD_DELETE` | false — archive via `is_active` |
| `POSTED_TRANSACTION_ENTITY_REASSIGNMENT` | false — reversal/repost only |
| `LEGAL_ENTITY_PERIOD_INDEPENDENCE` | true (16C implementation) |
| `ONE_DEFAULT_LEGAL_ENTITY_PER_ORG` | DB partial unique index |

---

## Patch 043 — accounting state entity isolation (2026-09-11)

Migration 042 changed `teller_accounting_state_versions` primary key from `organization_id` to `(organization_id, legal_entity_id)` so each legal entity owns its own optimistic-lock/version row.

Phase 9 bump RPCs (`teller_increment_accounting_version`, `teller_increment_close_state_version`, `teller_get_accounting_state`) and the journal insert trigger still used `ON CONFLICT (organization_id)`. That mismatch caused `postJournal` to fail after 042 with:

> there is no unique or exclusion constraint matching the ON CONFLICT specification

**Patch:** `supabase/patches/043_phase16c_accounting_state_entity.sql` (manual apply)

- Updates bump/get RPCs to accept `p_legal_entity_id` and conflict on `(organization_id, legal_entity_id)`
- Updates journal and close-state bump triggers to pass `NEW.legal_entity_id`

This is an **entity-isolation correction**, not an accounting-semantics change. Double-entry rules, period-close ordering, and HFAC behavior are unchanged.

---

## Intercompany (Phase 16D)

**Invariant preserved:** `CROSS_ENTITY_SINGLE_JOURNAL_ALLOWED = false`

Each economic event creates **two balanced journals** — one per legal entity — linked by `teller_intercompany_transactions`.

Example (expense on behalf):

| Entity A (payer) | Entity B (beneficiary) |
|------------------|------------------------|
| Dr Due From B | Dr Expense |
| Cr Cash/AP | Cr Due To A |

### Group model

`teller_intercompany_transactions` holds:

- `source_legal_entity_id`, `counterparty_legal_entity_id` (same org, must differ)
- `transaction_type`: `expense_on_behalf`, `cash_received_on_behalf`, `fund_transfer`, `manual`
- `source_journal_id`, `counterparty_journal_id` (both required when posted)
- `idempotency_key` (unique per org when set)
- `reverses_transaction_id` / `reversal_transaction_id` for paired reversals

Posted rows are **immutable** — corrections via atomic reversal RPC only.

### Due-to / Due-from accounts (Option A)

Per-entity, per-counterparty GL accounts (`teller_intercompany_account_pairs`):

- **Due From** counterparty → `asset`, subtype `due_from`
- **Due To** counterparty → `liability`, subtype `due_to`

Provisioned idempotently via `teller_provision_intercompany_accounts` on first use. Code pattern: `IC-DF-{ENTITY_CODE}`, `IC-DT-{ENTITY_CODE}`.

Not AR/AP trade balances — explicit intercompany subledger for reconciliation and future elimination metadata.

### Atomicity

`teller_atomic_post_intercompany` and `teller_atomic_reverse_intercompany` post both journals in one DB transaction. Simulated failure after source journal rolls back the entire group — `INTERCOMPANY_PARTIAL_POSTING_POSSIBLE = false`.

### Authorization

Initiator must have accounting access to **both** entities (`teller_can_access_legal_entity` on each side in RPC). Client-supplied entity UUIDs revalidated server-side.

### Period controls

Both entities' periods must be open for transaction/reversal date. No date shifting to work around a closed counterparty period.

### Reconciliation

`teller_intercompany_pair_balances(entity A, entity B)` compares:

- A Due From B ↔ B Due To A
- A Due To B ↔ B Due From A

Surfaces discrepancy only — **no auto-balancing journals**.

### Boundaries (16D)

| Out of scope | Notes |
|--------------|-------|
| Consolidation eliminations | 16F–16G reporting layer |
| Intercompany inventory | Deferred |
| Cross-entity payroll | Deferred |
| HFAC intercompany | HFAC unchanged; maps to default entity only |
| Tax engine changes | Phase 15 untouched |

**Migration:** `supabase/migrations/044_phase16d_intercompany.sql` (applied 2026-09-12)

### Patch 044 — provision pair lookup fix

When an intercompany account pair row already exists, the initial 044 RPC returned null `due_from`/`due-to` IDs due to a `SELECT INTO rowtype` mapping bug. Patch `supabase/patches/044_phase16d_provision_pair_lookup_fix.sql` corrects the lookup. App layer includes a pair-table fallback until the patch is applied.

---

## Intercompany settlement (Phase 16E)

Settlement **clears existing due-to/due-from balances** — it does not recreate original economics.

| Rule | Value |
|------|-------|
| `SETTLEMENT_CREATES_REVENUE` | false |
| `SETTLEMENT_CREATES_EXPENSE` | false |
| `SETTLEMENT_GENERATES_SALES_TAX` | false |
| `SETTLEMENT_PARTIAL_POSTING_POSSIBLE` | false |
| `AUTOMATIC_GL_NETTING` | false |
| `INTERCOMPANY_AUTO_BALANCING_ENTRY` | false |

### Settlement model

`teller_intercompany_settlements` — payer/payee entities, settlement date, amount, paired journal IDs, idempotency key, bank account linkage fields, lifecycle status (`draft` → `posted` → `reconciled` / `reversed`).

**Phase 16E cash model:** posted settlement assumes transfer completed (no pending clearing account). Bank feed matching deferred — `intercompany_settlement` added to `teller_bank_matches` resource types for future linkage without duplicate journal posting.

### Allocation truth

`teller_intercompany_settlement_allocations` links settlement cash to one or more open intercompany transactions.

- `amount_applied > 0`; sum must equal settlement amount
- Over-allocation rejected at RPC
- Open balance = original IC amount − sum(posted settlement allocations) — **not** mutable cached fields
- Supports partial settlement, multiple settlements per item, multi-item settlement

### Paired settlement journals

Payer (A owes B): Dr Due To B, Cr Cash. Payee (B): Dr Cash, Cr Due From A.

Posted atomically via `teller_atomic_post_intercompany_settlement`. Cash GL resolved server-side — `CLIENT_CONTROLLED_SETTLEMENT_CASH_ACCOUNT = false`.

### Reconciliation

`teller_intercompany_pair_reconciliation(entity A, entity B, as_of)` extends 16D pair balances with gross/net positions, open items, pair status, and as-of filtering.

### Reversal

`teller_atomic_reverse_intercompany_settlement` — paired reversal journals; original immutable; open balances restored.

**Migration:** `supabase/migrations/045_phase16e_intercompany_settlement.sql` (applied 2026-09-12)

### Patch 045 — reconciliation RPC + reversed settlement immutability

Initial 045 `teller_intercompany_pair_reconciliation` referenced invalid aliases in `last_activity` (`ic`/`s`). Patch `supabase/patches/045_phase16e_reconciliation_immutable_fix.sql` corrects the query and extends immutability to `reversed` settlements.

---

## Phase 16A deliverables

- Migration: `supabase/migrations/040_phase16a_legal_entity_foundation.sql` (**manual apply**)
- Module: `src/lib/accounting/legal-entity/`
- Static verify: `npm run verify:phase16:multi-entity`
- Controlled acceptance: `npm run accept:phase16:controlled` (after migration)
