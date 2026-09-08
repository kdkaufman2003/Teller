# Phase 13 — Inventory accounting, stock control & GRNI (production complete)

**Completed:** 2026-09-08  
**Migration:** `031_phase13_inventory.sql` (manually applied in Supabase SQL Editor — never auto-applied)  
**GRNI hotfixes (manual):** `031-grni-settle-rpc-fix.sql`, `031-grni-reversal-allocation-fix.sql`  
**Production deploy:** `https://teller-indol.vercel.app`  
**Git commit (application):** `f81f433`  
**Deployment ID:** `dpl_Du2Lfjuwh8hRcWYE7PT3fppmPawZ`

> **Permanent rule:** ALL Teller Supabase migrations and SQL patches are manually applied by the operator. Source control presence does not authorize automatic execution.

## Gates

| Gate | Result |
|------|--------|
| Migration 031 verified (REST probes) | PASS |
| GRNI settle RPC patch verified | PASS |
| GRNI reversal allocation patch verified | PASS |
| `teller_post_journal` signature unchanged | PASS |
| Local unit tests | **557/557** |
| Production build | PASS |
| Phase 13 controlled logic matrix | **178/178** real, **0** placeholders |
| Phase 13 DB acceptance (demo orgs) | **70/70** |
| Deployment compat audit | PASS |
| Phase 5–12 regressions | 18/18 · 32/32 · 45/45 · 67/67 · 102/102 · 110/110 · 105/105 · 88/88 · 110/110 |
| Pre-deploy HFAC baseline | 8 docs, 16 journals, Phase 13 inventory 0, GRNI allocations 0 |
| Production journals balanced | PASS |
| Production smoke test | PASS — `/login` 200; inventory/report routes 307 (auth); cron `enabled: false` |
| Post-deploy HFAC unchanged | PASS |
| Orphan scan (acceptance) | movements 0 · journals 0 · GRNI settlements 0 · broken transfers 0 |

**Snapshots:**  
- Pre-deploy: `artifacts/controlled-prod-snapshots/pre-phase13-deploy-2026-09-08T19-06-37-539Z.json`  
- Post-deploy: `artifacts/controlled-prod-snapshots/post-phase13-deploy-2026-09-08T19-36-22-562Z.json`

## Architecture (V1)

### Purchasing & GRNI

```
PO → Receipt → Dr Inventory Asset / Cr GRNI
            → Vendor bill → Dr GRNI (+/- PPV) / Cr AP
            → Payment → Dr AP / Cr Cash
            → Bank match (evidence only — no duplicate economics)
```

- Many-to-many receipt/bill settlement via `teller_inventory_receipt_bill_allocations`
- Same-day receipt + bill nets to Dr Inventory / Cr AP while preserving lineage
- Unmatched inventory bill lines blocked until receipt match exists

### Valuation & policy

| Topic | V1 decision |
|-------|-------------|
| Costing | Weighted average only |
| PPV | Configured Purchase Price Variance account; **no auto-capitalization** into inventory, COGS, or jobs |
| Negative inventory | **Prohibited** at DB level |
| Serial / lot tracking | **Deferred** (schema future-compatible) |

### Job material costing

- Receipt, bill settlement, AP payment, and bank match **do not** create job cost
- Material **issue** → Dr Direct Material / COGS, Cr Inventory
- Material **return** reverses linked issue economics at correct valuation
- Job profitability: `inventoryMaterialCost` + existing labor fields

### Reconciliation controls

| Control | Invariant |
|---------|-----------|
| Quantity | Movement ledger = balance quantities |
| Inventory value | Subledger = Inventory Asset GL |
| GRNI | Open unbilled receipt value = GRNI subledger = GRNI GL |
| Inventory COGS | Net inventory-originated consumption = Direct Material / COGS GL |

### Returns & transfers

- **Unbilled vendor return:** Dr GRNI / Cr Inventory
- **Transfer:** location-only; no org-wide GL economics
- **Receipt reversal:** blocked when matched until settlement unwound
- **Settlement reversal:** positive allocation qty + `reversal_of_allocation_id`

## Schema (migration 031)

- `teller_inventory_items`, `teller_inventory_locations`, `teller_inventory_movements`, `teller_inventory_balances`
- `teller_inventory_transfer_groups`, `teller_inventory_counts`, `teller_inventory_count_lines`
- `teller_inventory_account_mappings`, `teller_inventory_receipt_bill_allocations`
- GRNI columns on `teller_purchase_receipt_lines`
- RLS on all Phase 13 tables via org membership
- **`teller_post_journal` signature unchanged**

## Atomic RPCs

- `teller_atomic_receive_inventory`
- `teller_atomic_issue_inventory`
- `teller_atomic_transfer_inventory`
- `teller_atomic_reverse_inventory_movement`
- `teller_atomic_settle_inventory_receipt_bill`
- `teller_atomic_reverse_inventory_receipt_bill_allocation`

Post-deploy hotfix sources preserved under `supabase/patches/` for audit; applied manually only.

## Application deliverables

- Inventory hub (`/app/accounting/inventory/*`) — items, locations, movements, counts, reconciliation
- Reports: Inventory Valuation, Inventory by Location, Job Material Usage
- GRNI library: journals, settlement, reconciliation, aging, close findings
- Phase 7 job profitability integration (`inventoryMaterialCost`)
- Phase 9 close integration (blocking + warning findings)
- Phase 10 accountant package schedules (inventory + GRNI)
- HFAC hard refusal boundary — provider-neutral only; HFAC org unchanged

## Controlled harness

```bash
npm run setup:phase13-demo-org
npm run verify:migration:031:controlled
npm run verify:grni-settle-rpc-patch:controlled
npm run demo:phase13:controlled
npm run accept:phase13:controlled
npm run audit:phase13:deployment-compat
npm run snapshot:phase13:production -- pre-deploy
npm run snapshot:phase13:production -- post-deploy
```

## HFAC boundary

HFAC org `812be00d-3084-4227-ac71-ccbd22e4172c` — zero Phase 13 inventory/GRNI rows before and after deploy. Future event types (`inventory.receipt`, etc.) are documented but **not implemented**.

## Status

`PHASE_13_COMPLETE = true` · `PRODUCTION_DEPLOYED = true` · `PRODUCTION_SCHEDULER_ENABLED = false` · `PHASE_14_STARTED = false`
