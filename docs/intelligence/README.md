# Intelligence (Phase 11)

Rule-based insights and review suggestions. **Nothing in this module posts to the general ledger automatically.**

## What it does

- **Financial narrative** — plain-language summary of revenue, receivables, payables, and period close status
- **Live insights** — margin, collections, bank matching, draft expense reminders
- **Scan suggestions** — anomalies, expense category hints for bank lines, reconciliation reminders
- **Human review** — bookkeepers accept or dismiss suggestions; accept does not mutate books

## Receipt AI

When `OPENAI_API_KEY` is set, receipt upload continues to use vision extraction (`receipt-analyze.ts`). The dashboard shows that AI is enabled; categorization scans still prefer deterministic rules first.

## API

- `GET /api/intelligence` — narrative + insights + pending suggestions
- `POST /api/intelligence` — run scan (bookkeepers+)
- `PATCH /api/intelligence/suggestions/:id` — accept or dismiss

## Database

`011_intelligence.sql` → `teller_intelligence_suggestions`
