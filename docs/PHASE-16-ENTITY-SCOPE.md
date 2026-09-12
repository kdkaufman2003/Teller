# Phase 16H — Accounting scope registry

Canonical classification of settings and controls by scope. Use this when adding new accounting features.

## Scope types

| Scope | Meaning |
|-------|---------|
| **Organization** | Shared across all legal entities in the org |
| **Legal entity** | Isolated per company books |
| **User** | UX preference only — never authorization |
| **Consolidation** | Reporting-layer only; never entity journals |

## Organization-scoped

| Setting / control | Storage | Notes |
|-------------------|---------|-------|
| Organization membership | `teller_profiles` | Role is org-level |
| Industry profile | `teller_industry_settings` | Terminology / setup answers |
| Tax registrations & rules | `teller_tax_*` (035) | Reference data; liability accounts are entity-scoped |
| Tax mode / flat rate (org answers) | `teller_industry_settings.answers` | UI may merge with entity liability account refs |
| Parties (customers/vendors) | `teller_parties` | Shared identity; balances are entity-scoped |
| Jobs (operational) | `teller_jobs` | Shared catalog; accounting lines carry entity via document/journal |
| HFAC integration mapping | org external ID → org | Posts resolve to default legal entity server-side |
| Banking provider connections | org-level tokens | Bank **accounts** are entity-scoped |

## Legal-entity-scoped

| Setting / control | Storage | Notes |
|-------------------|---------|-------|
| Chart of accounts | `teller_accounts.legal_entity_id` | Unique `(legal_entity_id, code)` |
| Journals | `teller_journal_entries.legal_entity_id` | Lines inherit via RPC account match |
| Documents (AR/AP) | `teller_documents.legal_entity_id` | Number unique per `(legal_entity_id, kind, number)` |
| Payments | `teller_payments.legal_entity_id` | Allocations must match document entity |
| Bank accounts | `teller_bank_accounts.legal_entity_id` | GL cash account must match entity |
| Period close | `teller_period_closes.legal_entity_id` | Independent close per entity |
| Accounting state version | `(organization_id, legal_entity_id)` | Optimistic locking per entity |
| Default GL accounts | `teller_entity_accounting_settings` | AR, AP, cash, retained earnings, deposits |
| Entity tax liability account refs | settings `metadata` | Sales tax payable, use tax expense |
| Fiscal year start / accounting method | `teller_entity_accounting_settings` | Entity books basis |
| Fixed assets | `teller_fixed_assets.legal_entity_id` | Depreciation posts to entity COA |
| Inventory accounting | entity COA + entity journals | Locations may be org-shared; GL is entity-scoped |
| Intercompany transactions | both entities explicit | Dual period control (16D/16E) |
| Entity access grants | `teller_legal_entity_memberships` | Restricted users limited to granted entities |

## User-scoped

| Setting | Storage | Notes |
|---------|---------|-------|
| Active legal entity | `teller_profiles.active_legal_entity_id` | UX only; server revalidates every request |

## Consolidation-scoped

| Setting / control | Storage | Notes |
|-------------------|---------|-------|
| Elimination entries | `teller_consolidation_elimination_*` | Never posts to entity journals |
| Consolidation report locks | `teller_consolidation_report_locks` | Does not close entity periods |
| Consolidation scope key | derived | Org + sorted entity IDs |

## Intentional cross-scope rules

1. **HFAC** → resolves to org default legal entity; default entity change blocked when HFAC enabled.
2. **Zero membership rows** → backward-compatible access to all org entities until first membership grant (16B). Re-evaluate before multi-entity launch hardening.
3. **Intercompany RLS OR** → user may read IC row if they can access either payer or payee entity (16D/16E reconciliation).
4. **Consolidation eliminations** → require access to all entities in scope when restricted.

## Phase 16J closeout

Phase 16 production release: commit `edc0dc6`, Vercel deployment `DnSbrrRVaY63RCN27tKZQrXagnLW`. See [PHASE-16-CLOSEOUT.md](./PHASE-16-CLOSEOUT.md).

---

## Deferred (not 16H)

- Multicurrency / FX translation
- NCI, goodwill, purchase accounting
- Consolidated tax filing
- Intercompany inventory profit / fixed asset transfer elimination
- Multi-EIN payroll engine
- Full Phase 14 planning entity dimension redesign
