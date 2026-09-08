# Phase 13 — Inventory Accounting (Local)

Phase 13 adds inventory accounting, stock control, and **GRNI (Goods Received Not Invoiced)** to Teller. This pass is **local only** — migration 031 is prepared but **not applied**.

## Purchasing flow (GRNI included)

```
PO → Receipt → Dr Inventory / Cr GRNI
            → Vendor Bill → Dr GRNI (+/- PPV) / Cr AP
            → Payment → Dr AP / Cr Cash
            → Bank Match (evidence only)
```

Same-day receipt + bill nets to **Dr Inventory / Cr AP** while preserving full lineage.

## V1 decisions

| Topic | Decision |
|-------|----------|
| Valuation | Weighted average cost only |
| Receipt recognition | **Dr Inventory Asset / Cr GRNI** at economic receipt |
| Bill settlement | **Dr GRNI (+/- PPV) / Cr AP** — never debit inventory again for matched receipts |
| Receipt cost | PO line unit cost, then explicit receipt cost; **block** if missing |
| PPV | Deterministic PPV account; **no auto-capitalization** to inventory/COGS/jobs in V1 |
| Unmatched inventory bill | Requires receipt match before GRNI settlement; no silent on-hand debit |
| Job costing | GRNI never hits jobs; material cost only on inventory issue |
| Consume before bill | Supported; bill settlement clears GRNI/PPV independently |
| Unbilled vendor return | Dr GRNI / Cr Inventory |
| Serial/lot | Deferred (schema future-compatible) |
| HFAC | Hard refusal — provider-neutral boundary only |

## GRNI controls

- **Open receipt value = GRNI subledger = GRNI GL** (independently from inventory subledger)
- Ending inventory ≠ GRNI (inventory may be consumed before bill arrives)
- Many-to-many receipt/bill settlement via `teller_inventory_receipt_bill_allocations`
- Matched receipt reversal blocked until settlement unwound

## Migration

- File: `supabase/migrations/031_phase13_inventory.sql` (includes GRNI schema + RPCs)
- **Manual apply only** after local acceptance authorization
- Does **not** alter `teller_post_journal`

## Local gates

```bash
npm test
npm run build
npm run demo:phase13:controlled
npm run audit:phase13:deployment-compat
```

DB acceptance (`accept:phase13:controlled`) remains **BLOCKED** until migration 031 is manually applied, then runs real GRNI scenarios (target ≥60).

## Demo orgs

- `Teller Phase 13 Demo` — `setup:phase13-demo-org`
- `Teller Phase 13 Foreign Test` — tenant isolation checks

## Status

`PHASE_13_COMPLETE = false` · `PRODUCTION_DEPLOYED = false`
