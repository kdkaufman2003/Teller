# Accounting health engine (Phase 8)

Teller computes a **bookkeeping health score** from signals already in the books — no separate manual checklist.

## Score factors

| Factor | Weight | Signals |
|--------|--------|---------|
| Invoicing | 30% | Draft invoices, overdue open invoices |
| Expenses | 20% | Draft expenses, receipt expenses missing attachments |
| Bank feed | 25% | Unmatched/suggested transactions, connection errors (when connected) |
| Integrations | 10% | Stale Hassle Free AC sync (when enabled) |
| Sales tax | 15% | Tax determinations pending review |

Factors with zero weight (e.g. bank feed when no bank is connected) are excluded from the weighted average.

## Attention items

The dashboard **Needs attention** list links directly to invoices, expenses, banking, or settings — owner-friendly language, same accounting engine underneath.

## API

`GET /api/health` — returns `{ report, signals }` for the current organization.

## Extension points

Future phases can add period close, statement reconciliation, and anomaly detection as additional factors without changing the dashboard UX contract.
