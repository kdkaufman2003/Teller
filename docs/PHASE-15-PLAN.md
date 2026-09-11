# Phase 15 Plan — Sales Tax & Tax Accounting

**Status:** 15A foundation in progress · **Production:** Phase 14 deployed

> **Permanent rule:** ALL Teller Supabase migrations and SQL patches are manually applied by the operator.

---

## Product principle

Teller remains **robust accounting underneath + simple business language on top**.

Phase 15 builds a serious sales/use-tax accounting foundation. Teller:

- calculates, records, tracks, reconciles, reports, and prepares tax obligations
- does **not** file returns, submit to states, provide legal opinions, or replace a CPA

---

## Accounting model

Sales tax collected is **not revenue**.

```
Invoice:  Service $10,000 + Tax $800 = $10,800

Dr Accounts Receivable     10,800
    Cr Revenue             10,000
    Cr Sales Tax Payable      800
```

Tax authority payment:

```
Dr Sales Tax Payable        800
    Cr Cash                   800
```

Use tax foundation respects existing AP/inventory/fixed-asset posting paths (Phase 15E).

---

## Architecture layers

| Layer | Role |
|-------|------|
| Tax configuration | Jurisdictions, rates, rules, registrations, exemptions |
| Tax subledger | `teller_tax_transactions` + components + immutable snapshots |
| GL | Accounting truth — Sales & Use Tax Payable control account |
| Reconciliation | Subledger liability = GL payable (± timing/adjustments) |

---

## Existing foundation (pre-15)

Phase 6 shipped `src/lib/tax/` + migration `008_tax_engine.sql`:

- Rule sets, jurisdictions, rates, rules, determinations
- Flat-rate invoice tax (default) + jurisdiction engine hook
- Document-level `tax` on `teller_documents`
- Phase 10 sales tax summary report (aggregate)
- Phase 11.1 purchase tax capitalization

Phase 15 **extends** this — does not replace it.

---

## Jurisdiction model

Hierarchy: country → state → county → city → district

- **Jurisdiction** = where / rule scope
- **Authority** = who receives liability (separate table)
- Combined rates decomposed into **rate components**

No `if state === "KS"` in application logic — configuration-driven.

---

## Missouri + Kansas

Initial target states in **15H** via configurable reference rule packs.

Phase 15 distinguishes:

- **Engine capability** (15A–15G)
- **Legal/tax configuration** (15H — versioned, reviewable, not from LLM memory)

---

## Slice roadmap

| Slice | Scope |
|-------|--------|
| **15A** | Foundation + jurisdiction model + migration 035 |
| **15B** | Calculation engine + line taxability + rate composition |
| **15C** | Customer exemptions + certificates |
| **15D** | Invoice/credit/refund tax posting |
| **15E** | Purchasing + use tax |
| **15F** | Filing periods + liability reconciliation |
| **15G** | Authority payments + adjustments |
| **15H** | Missouri/Kansas configuration packs |
| **15I** | Tax reports + accountant package |
| **15J** | Owner tax dashboard / UX |
| **15K** | Final acceptance |
| **15L** | Production deployment |

---

## Security

- All org tax rows scoped by `organization_id` + RLS
- Cross-org FK triggers on settings, transactions, exemptions
- HFAC org read-only in controlled acceptance
- Posted tax history immutable (snapshots + posted transactions)

---

## Provider boundary

External providers (Avalara, TaxJar, Vertex, Stripe Tax) deferred.

`TaxDeterminationProvider` interface allows future adapters; Teller-native provider first.

---

## Explicit deferrals

- Automated return filing / submission
- Income tax, payroll filing, property tax, 1099/W-2 prep
- Nexus monitoring, tax notices, ML classification
- Multi-entity consolidation
- Phase 16+

---

## Manual SQL rule

Cursor prepares migration SQL and verifiers only. Operator applies `035_phase15_tax_accounting.sql` manually.
