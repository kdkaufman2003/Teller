# Teller tax engine

Phase 6 introduces a **jurisdiction tax engine** that is separate from authoritative tax rules.

## Separation of concerns

| Layer | Responsibility | Lives in |
|-------|----------------|----------|
| **Engine** | Evaluate versioned rules, resolve rates, store determinations with explanations | `src/lib/tax/` |
| **Rule specification** | Authoritative treatment by jurisdiction, transaction type, product category | `tax-rules/` (version-controlled JSON) |
| **Governance** | Review workflow before rules become `active` | This document + `tax-rules/README.md` |

**Cursor builds the engine. Tax rules populate it.**

Do **not** embed Missouri/Kansas (or any state) tax treatment as hard-coded `if (state === "MO")` logic in application code. Conditions and rates are **data** loaded from reviewed spec files.

## Rule lifecycle

1. **Draft** — rule JSON authored in `tax-rules/pending/` from primary sources (state DOR, local authority publications, professional review notes).
2. **Reviewed** — accountant/tax advisor confirms citations and effective dates.
3. **Active** — loaded into `teller_tax_rule_sets` via `npm run tax-rules:load` (production deploy step).
4. **Retired** — superseded by a newer version; kept for historical determinations.

Only **`active`** rule sets within their effective date range drive jurisdiction-mode calculations.

## Organization tax modes

- **`flat`** (default) — existing behavior: organization `taxRate` × subtotal. Unchanged for orgs not ready for jurisdiction rules.
- **`jurisdiction`** — engine evaluates loaded active rule sets. If none are active, Teller **falls back to flat rate** and marks determinations `pending_review` with `noActiveRules: true`.

Teller does **not** claim legal tax compliance from calculations alone.

## Engine pipeline

```
Transaction + line context
    → find active rule set(s) for date
    → match first rule by priority (data-driven conditions)
    → apply action (taxable / exempt / non_taxable / defer_to_manual)
    → resolve jurisdiction rate (versioned by effective date)
    → store teller_tax_determinations with explanation
```

## API

- `POST /api/tax/preview` — preview line-level determinations before posting an invoice.

## Adding jurisdiction rules

See [`tax-rules/README.md`](../tax-rules/README.md) and [`tax-rules/schema/rule-set.schema.json`](../tax-rules/schema/rule-set.schema.json).

No Missouri or Kansas rule files ship with Teller until they pass the review workflow and are explicitly loaded.
